import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env.server";
import { sourceByKey, type SourceAdapter, type SourceGrant } from "./sources";

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

  const { data: run } = await supabase
    .from("source_runs")
    .insert({ source_key: adapter.key })
    .select("id")
    .single();
  const runId = (run as { id: string } | null)?.id;

  try {
    const harvest = await adapter.harvest({ limit: options.limit });

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

    const { data: funderRows, error: funderReadError } = await supabase
      .from("funders")
      .select("id, name, country");
    if (funderReadError) throw new Error(funderReadError.message);

    const funderId = new Map<string, string>();
    for (const row of (funderRows ?? []) as Array<{ id: string; name: string; country: string }>) {
      funderId.set(`${row.name.toLowerCase()}|${row.country}`, row.id);
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
        source_key: adapter.key,
        source_hash: sourceHash(adapter.key, grant.externalId),
        last_seen_at: new Date().toISOString(),
      });
    }

    let grantsUpserted = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const { data, error } = await supabase
        .from("grants")
        .upsert(rows.slice(i, i + 100), { onConflict: "source_hash" })
        .select("id");
      if (error) throw new Error(`grant upsert failed: ${error.message}`);
      grantsUpserted += data?.length ?? 0;
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

export async function runSourceByKey(key: string, options: { limit?: number } = {}) {
  const adapter = sourceByKey(key);
  if (!adapter) throw new Error(`unknown source: ${key}`);
  return runSource(adapter, options);
}
