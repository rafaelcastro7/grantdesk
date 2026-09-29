import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env.server";
import type { SourceAdapter, SourceGrant } from "./sources";
import { todayIn } from "@/lib/deadline";

/**
 * Run a source and fold its harvest into the catalog.
 *
 * Idempotent by construction: every grant carries a hash of its source key and
 * external id, and re-running updates in place rather than duplicating. That
 * is what lets ingestion be scheduled without a deduplication pass, and it is
 * asserted by a test rather than assumed.
 *
 * Writes use the service role because the catalog is shared reference data
 * that no individual consultant owns — the RLS policies deliberately make it
 * read-only to them.
 */

export function sourceHash(sourceKey: string, externalId: string): string {
  return createHash("sha256").update(`${sourceKey}:${externalId}`).digest("hex");
}

function adminClient(): SupabaseClient {
  const env = serverEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type IngestResult = {
  sourceKey: string;
  fundersUpserted: number;
  grantsUpserted: number;
  skippedWithoutFunder: number;
  durationMs: number;
};

export async function runSource(
  adapter: SourceAdapter,
  options: { limit?: number; client?: SupabaseClient } = {},
): Promise<IngestResult> {
  const supabase = options.client ?? adminClient();
  const started = Date.now();

  const runStarted = new Date(started).toISOString();

  // What the last good full run delivered, to catch a source that quietly
  // shrank (a changed page layout parses to fewer rows, not to zero).
  const { data: previousRun } = await supabase
    .from("source_runs")
    .select("grants_upserted")
    .eq("source_key", adapter.key)
    .eq("status", "ok")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // A run that cannot be recorded is not run: an unrecorded failure would
  // leave coverage calling this source fresh.
  const { data: run, error: runError } = await supabase
    .from("source_runs")
    .insert({ source_key: adapter.key })
    .select("id")
    .single();
  if (runError) throw new Error(`could not record the ${adapter.key} run: ${runError.message}`);
  const runId = (run as { id: string } | null)?.id;

  try {
    const harvest = await adapter.harvest({ limit: options.limit });
    const before = (previousRun as { grants_upserted: number | null } | null)?.grants_upserted ?? 0;
    if (options.limit === undefined && before >= 20 && harvest.grants.length < before * 0.5) {
      throw new Error(
        `${adapter.key} returned ${harvest.grants.length} calls against ${before} last time — ` +
          "the source probably changed its layout; nothing was written",
      );
    }

    // Funders first: grants reference them, and a grant whose funder failed to
    // land must be skipped loudly rather than attached to the wrong one.
    let fundersUpserted = 0;
    for (let i = 0; i < harvest.funders.length; i += 100) {
      const chunk = harvest.funders.slice(i, i + 100).map((f) => ({
        name: f.name,
        country: f.country,
        jurisdiction: f.jurisdiction ?? null,
        category: f.category ?? null,
        website: f.website ?? null,
        source_key: adapter.key,
      }));
      const { data, error } = await supabase
        .from("funders")
        .upsert(chunk, { onConflict: "name,country" })
        .select("id");
      if (error) throw new Error(`funder upsert failed: ${error.message}`);
      fundersUpserted += data?.length ?? 0;
    }

    // Paged: a hosted PostgREST caps unpaged reads (1000 rows by default), and
    // a funder past the cap would silently drop every grant it funds.
    const funderId = new Map<string, string>();
    for (let from = 0; ; from += 1000) {
      const { data: page, error: funderReadError } = await supabase
        .from("funders")
        .select("id, name, country")
        .order("id")
        .range(from, from + 999);
      if (funderReadError) throw new Error(funderReadError.message);
      for (const row of (page ?? []) as Array<{ id: string; name: string; country: string }>) {
        funderId.set(`${row.name.toLowerCase()}|${row.country}`, row.id);
      }
      if ((page ?? []).length < 1000) break;
    }

    const rows: Array<Record<string, unknown>> = [];
    let skippedWithoutFunder = 0;
    for (const grant of harvest.grants as SourceGrant[]) {
      const id = funderId.get(`${grant.funderName.toLowerCase()}|${grant.funderCountry}`);
      if (!id) {
        skippedWithoutFunder++;
        continue;
      }
      rows.push({
        funder_id: id,
        title: grant.title,
        summary: grant.summary ?? null,
        url: grant.url,
        country: grant.country,
        currency: grant.currency ?? null,
        amount_min: grant.amountMin ?? null,
        amount_max: grant.amountMax ?? null,
        deadline: grant.deadline ?? null,
        language: grant.language ?? "en",
        eligible_applicant_types: grant.eligibleApplicantTypes ?? [],
        eligibility_note: grant.eligibilityNote ?? null,
        assistance_listings: grant.assistanceListings ?? [],
        documents: grant.documents ?? [],
        contact: grant.contact ?? null,
        estimated_deadline: grant.estimatedDeadline ?? null,
        cost_sharing_required: grant.costSharingRequired ?? null,
        deadline_note: grant.deadlineNote ?? null,
        opportunity_number: grant.opportunityNumber ?? null,
        // A source badge saying "open" on a date that has passed is stale
        // markup; re-reading it must not reopen an expired call.
        ...(grant.status
          ? {
              status:
                grant.status === "open" && grant.deadline && grant.deadline < todayIn()
                  ? "expired"
                  : grant.status,
            }
          : {}),
        source_key: adapter.key,
        source_hash: sourceHash(adapter.key, grant.externalId),
        last_seen_at: new Date().toISOString(),
      });
    }

    // One row per key. Two harvested items with the same external id in one
    // batch make Postgres refuse the whole upsert ("cannot affect row a second
    // time"), which failed the entire source over a duplicate listing.
    const unique = [...new Map(rows.map((row) => [row.source_hash as string, row])).values()];
    rows.length = 0;
    rows.push(...unique);

    let grantsUpserted = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const { data, error } = await supabase
        .from("grants")
        .upsert(rows.slice(i, i + 100), { onConflict: "source_hash" })
        .select("id");
      if (error) throw new Error(`grant upsert failed: ${error.message}`);
      grantsUpserted += data?.length ?? 0;
    }

    // A full read is the source's complete list: anything it no longer
    // publishes has closed or been withdrawn, and must stop reading as open.
    // Skipped on a limited run, which by design saw only part of the list.
    if (options.limit === undefined && grantsUpserted > 0) {
      const { error: closeError } = await supabase
        .from("grants")
        .update({ status: "closed" })
        .eq("source_key", adapter.key)
        .in("status", ["open", "forecasted"])
        .lt("last_seen_at", runStarted);
      if (closeError) throw new Error(`could not close withdrawn calls: ${closeError.message}`);
    }

    if (runId) {
      await supabase
        .from("source_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: "ok",
          funders_upserted: fundersUpserted,
          grants_upserted: grantsUpserted,
        })
        .eq("id", runId);
    }

    return {
      sourceKey: adapter.key,
      fundersUpserted,
      grantsUpserted,
      skippedWithoutFunder,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    // A failed run is recorded, not swallowed: coverage reports staleness from
    // the last *successful* run, so a silently failing source would otherwise
    // keep claiming a market is fresh.
    if (runId) {
      await supabase
        .from("source_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: "failed",
          error: error instanceof Error ? error.message.slice(0, 500) : String(error),
        })
        .eq("id", runId);
    }
    throw error;
  }
}
