import type { SupabaseClient } from "@supabase/supabase-js";
import { decideEligibility, type Verdict } from "@/lib/eligibility";
import { hasQueryableProfile, lexicalQuery, semanticQuery } from "@/lib/match-query";
import { matchedTerms } from "@/lib/match-explain";
import type { ApplicantType } from "@/lib/applicant-types";
import { retrievalBands } from "@/lib/regions";
import { embedOne } from "./embed";

/**
 * Retrieve, then decide, then record.
 *
 * The order matters and is the whole thesis of the product. Retrieval is
 * allowed to be fuzzy — that is what recall is for — but nothing fuzzy reaches
 * the verdict. Between the two sits a rules engine whose answers are the same
 * every time, and both the verdict and the rule results are written down so
 * "why is this here?" is answerable from the database months later.
 *
 * Retrieval deliberately does *not* filter anyone out by country — that is
 * still the eligibility rules' job, and a grant the client cannot apply for
 * still comes back marked ineligible with a reason.
 *
 * It is banded by country, though, and that took a real measurement to admit
 * was necessary. A single relevance-ranked search for a Canadian client
 * returned ten Canadian calls out of sixty, out of 1,321 open ones in the
 * catalog — not because they were ruled out, but because Canada is ~30% of
 * the ranking at every depth and the other 1,311 never got looked at. A country
 * filter would have thrown the rest of the continent away; a relevance boost
 * would have fixed it by an amount nobody could state. So the budget is split
 * instead, home country first, by a stated fraction — see regions.ts.
 */

const CANDIDATE_POOL = 300;
const MATCH_LIMIT = 60;

export type ProfileRow = {
  sectors: string[] | null;
  jurisdictions: string[] | null;
  stage: string | null;
  annual_budget: number | null;
  currency: string | null;
  capabilities: string | null;
  beneficiaries: string | null;
  lead_time_weeks: number | null;
  funded_partner_pathway: boolean | null;
  partner_lead_time_weeks: number | null;
  capability_domains: string[] | null;
};

export type MatchRow = {
  grantId: string;
  verdict: Verdict;
  relevance: number;
  headline: string;
  retrieval: { lexicalRank: number | null; vectorRank: number | null; terms: string[] };
  checks: Array<{ key: string; status: string; isHardGate: boolean; detail: string }>;
};

export type MatchRunResult = {
  clientId: string;
  retrieved: number;
  eligible: number;
  needsInput: number;
  ineligible: number;
  /** Which halves of retrieval actually ran, so a degraded run is visible. */
  usedLexical: boolean;
  usedVector: boolean;
  /**
   * How the retrieval budget was actually spent. Empty when the client has no
   * recognized home country in the Americas, in which case the whole budget
   * went to one undifferentiated search.
   */
  bands: Array<{ key: "home" | "americas"; label: string; searched: number }>;
  durationMs: number;
};

export class ProfileTooThinError extends Error {
  constructor() {
    super("profile_too_thin");
    this.name = "ProfileTooThinError";
  }
}

type GrantRow = {
  id: string;
  title: string;
  summary: string | null;
  country: string;
  deadline: string | null;
  status: string | null;
  eligible_applicant_types: string[] | null;
  eligibility_note: string | null;
  amount_min: number | null;
  amount_max: number | null;
  currency: string | null;
};

/**
 * Rank the catalog for one client and store the verdicts.
 *
 * Returns counts rather than rows: the screen reads `matches`, so a run that
 * reported success while writing nothing would be caught here rather than
 * looking like an empty catalog.
 */
export async function runMatch(
  supabase: SupabaseClient,
  clientId: string,
  options: { today?: Date; limit?: number } = {},
): Promise<MatchRunResult> {
  const started = Date.now();
  const today = options.today ?? new Date();

  const { data: profileData, error: profileError } = await supabase
    .from("client_profiles")
    .select(
      "sectors, jurisdictions, stage, annual_budget, currency, capabilities, beneficiaries, " +
        "lead_time_weeks, funded_partner_pathway, partner_lead_time_weeks, capability_domains",
    )
    .eq("client_id", clientId)
    .maybeSingle();
  if (profileError) throw new Error(`could not read the profile: ${profileError.message}`);

  const profile = (profileData ?? null) as ProfileRow | null;
  if (!profile || !hasQueryableProfile(profile)) throw new ProfileTooThinError();

  const lexical = lexicalQuery(profile);
  const semantic = semanticQuery(profile);

  // The embedder is local and can be down. That degrades matching to lexical
  // only, which is worse but usable — and the caller is told which halves ran
  // rather than being handed a quietly shorter list.
  let embedding: number[] | null = null;
  if (semantic) {
    try {
      embedding = await embedOne(semantic);
    } catch {
      embedding = null;
    }
  }
  if (!lexical && !embedding) throw new ProfileTooThinError();

  type Hit = {
    grant_id: string;
    lexical_rank: number | null;
    vector_rank: number | null;
    score: number;
  };

  // One call per band, each restricted to its own countries. Bands are
  // disjoint by construction (regions.ts never repeats a country across
  // them), so the results need no deduplication — just concatenation.
  const bands = retrievalBands(profile.jurisdictions, options.limit ?? MATCH_LIMIT);
  const ranked: Hit[] = [];
  const bandSummary: MatchRunResult["bands"] = [];
  for (const band of bands) {
    if (band.budget <= 0) continue;
    const { data: hits, error: searchError } = await supabase.rpc("search_grants", {
      q: lexical || null,
      q_embedding: embedding ? JSON.stringify(embedding) : null,
      q_language: "en",
      countries: band.countries,
      pool: CANDIDATE_POOL,
      result_limit: band.budget,
    });
    if (searchError) throw new Error(`retrieval failed (${band.label}): ${searchError.message}`);
    const found = (hits ?? []) as Hit[];
    ranked.push(...found);
    // What actually came back, not the budget offered — a band with fewer
    // candidates than its share is not the same event as one that filled it.
    bandSummary.push({ key: band.key, label: band.label, searched: found.length });
  }

  if (ranked.length === 0) {
    return {
      clientId,
      retrieved: 0,
      eligible: 0,
      needsInput: 0,
      ineligible: 0,
      usedLexical: !!lexical,
      usedVector: !!embedding,
      bands: bandSummary,
      durationMs: Date.now() - started,
    };
  }

  // Chunked deliberately. PostgREST puts an `in.(…)` list in the query string,
  // and a few hundred UUIDs overflow the gateway's header buffer — which comes
  // back as a bare "invalid response from the upstream server" that says
  // nothing about length. The chunk size is well under that limit.
  const grants = new Map<string, GrantRow>();
  const ids = ranked.map((r) => r.grant_id);
  for (let i = 0; i < ids.length; i += 50) {
    const { data, error } = await supabase
      .from("grants")
      .select(
        "id, title, summary, country, deadline, status, eligible_applicant_types, " +
          "eligibility_note, amount_min, amount_max, currency",
      )
      .in("id", ids.slice(i, i + 50));
    if (error) throw new Error(`could not read candidates: ${error.message}`);
    for (const grant of (data ?? []) as unknown as GrantRow[]) grants.set(grant.id, grant);
  }

  const decided: MatchRow[] = [];
  for (const hit of ranked) {
    const grant = grants.get(hit.grant_id);
    if (!grant) continue;

    const decision = decideEligibility({
      grant: {
        title: grant.title,
        country: grant.country,
        deadline: grant.deadline,
        status: grant.status,
        eligibleApplicantTypes: (grant.eligible_applicant_types ?? []) as ApplicantType[],
        // The funder's own prose, where a cost share is stated if it is stated
        // at all — it is never a structured field.
        eligibilityNote: grant.eligibility_note,
        summary: grant.summary,
        amountMin: grant.amount_min,
        amountMax: grant.amount_max,
        currency: grant.currency,
      },
      client: {
        jurisdictions: profile.jurisdictions,
        stage: profile.stage,
        annualBudget: profile.annual_budget,
        currency: profile.currency,
        leadTimeWeeks: profile.lead_time_weeks,
        fundedPartnerPathway: profile.funded_partner_pathway,
        partnerLeadTimeWeeks: profile.partner_lead_time_weeks,
        capabilityDomains: profile.capability_domains,
      },
      today,
    });

    decided.push({
      grantId: hit.grant_id,
      verdict: decision.verdict,
      relevance: Number(hit.score),
      headline: decision.headline,
      retrieval: {
        lexicalRank: hit.lexical_rank,
        vectorRank: hit.vector_rank,
        // Which of the client's own words this funder's text actually
        // contains. Stored rather than recomputed: the profile can change,
        // and a reason that silently rewrites itself is not a reason.
        terms: matchedTerms(
          profile.sectors,
          `${grant.title}
${grant.summary ?? ""}`,
        ),
      },
      checks: decision.checks.map((c) => ({
        key: c.key,
        status: c.status,
        isHardGate: c.isHardGate,
        detail: c.detail,
      })),
    });
  }

  // Every verdict is stored, including every rejection. "Why is this here?"
  // and "did you even look at that one?" both have to stay answerable from the
  // database months later, and a record that quietly drops the low-ranked
  // rejections cannot answer the second.
  //
  // The screen is where the amount is a problem, and that is where it is
  // solved: measured on a Canadian client against this catalog, 51 of 60
  // results were ruled out on jurisdiction alone — the US half has richer
  // descriptions and ranks better — so the consultant met nine usable calls and
  // fifty-one proofs of diligence. The results page shows a bounded sample of
  // the rejections; the record keeps all of them.
  await persist(supabase, clientId, decided);

  return {
    clientId,
    retrieved: decided.length,
    eligible: decided.filter((m) => m.verdict === "eligible").length,
    needsInput: decided.filter((m) => m.verdict === "needs_input").length,
    ineligible: decided.filter((m) => m.verdict === "ineligible").length,
    usedLexical: !!lexical,
    usedVector: !!embedding,
    bands: bandSummary,
    durationMs: Date.now() - started,
  };
}

/**
 * Replace this client's matches wholesale.
 *
 * A profile edit can change every verdict, so merging would leave stale
 * decisions behind that no longer follow from any rule — a consultant reading
 * a reason that contradicts the current profile has no way to tell which is
 * right. Checks cascade from the match rows, so deleting matches clears them.
 *
 * Done as one call into replace_matches (a single transaction, serialized per
 * client by an advisory lock), not three separate delete/insert/insert round
 * trips from here. Those three used to race: a double-clicked "Find matches",
 * or a manual run overlapping a profile-driven re-check, could interleave —
 * both deletes racing, then both inserts landing as duplicates, or one run's
 * delete firing after the other's insert and silently wiping a result set
 * the consultant had just been told succeeded.
 */
async function persist(supabase: SupabaseClient, clientId: string, rows: MatchRow[]) {
  const { error } = await supabase.rpc("replace_matches", {
    target_client: clientId,
    match_rows: rows.map((row) => ({
      grant_id: row.grantId,
      verdict: row.verdict,
      relevance: row.relevance,
      retrieval: row.retrieval,
      checks: row.checks.map((check) => ({
        rule_key: check.key,
        status: check.status,
        is_hard_gate: check.isHardGate,
        detail: check.detail,
      })),
    })),
    matched_at: new Date().toISOString(),
  });
  if (error) throw new Error(`could not store matches: ${error.message}`);
}
