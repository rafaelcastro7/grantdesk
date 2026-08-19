import type { SupabaseClient } from "@supabase/supabase-js";
import { decideEligibility, type Verdict } from "@/lib/eligibility";
import { hasQueryableProfile, lexicalQuery, semanticQuery } from "@/lib/match-query";
import type { ApplicantType } from "@/lib/applicant-types";
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
 * Retrieval deliberately does *not* filter by country. A grant the client
 * cannot apply for has to come back and be marked ineligible with a reason,
 * because a consultant needs to know it was considered and ruled out — a
 * silently filtered result is indistinguishable from a missing one.
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
};

export type MatchRow = {
  grantId: string;
  verdict: Verdict;
  relevance: number;
  headline: string;
  retrieval: { lexicalRank: number | null; vectorRank: number | null };
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
  country: string;
  deadline: string | null;
  status: string | null;
  eligible_applicant_types: string[] | null;
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
    .select("sectors, jurisdictions, stage, annual_budget, currency, capabilities, beneficiaries")
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

  const { data: hits, error: searchError } = await supabase.rpc("search_grants", {
    q: lexical || null,
    q_embedding: embedding ? JSON.stringify(embedding) : null,
    q_language: "en",
    countries: null,
    pool: CANDIDATE_POOL,
    result_limit: options.limit ?? MATCH_LIMIT,
  });
  if (searchError) throw new Error(`retrieval failed: ${searchError.message}`);

  const ranked = (hits ?? []) as Array<{
    grant_id: string;
    lexical_rank: number | null;
    vector_rank: number | null;
    score: number;
  }>;
  if (ranked.length === 0) {
    return {
      clientId,
      retrieved: 0,
      eligible: 0,
      needsInput: 0,
      ineligible: 0,
      usedLexical: !!lexical,
      usedVector: !!embedding,
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
        "id, country, deadline, status, eligible_applicant_types, amount_min, amount_max, currency",
      )
      .in("id", ids.slice(i, i + 50));
    if (error) throw new Error(`could not read candidates: ${error.message}`);
    for (const grant of (data ?? []) as GrantRow[]) grants.set(grant.id, grant);
  }

  const decided: MatchRow[] = [];
  for (const hit of ranked) {
    const grant = grants.get(hit.grant_id);
    if (!grant) continue;

    const decision = decideEligibility({
      grant: {
        country: grant.country,
        deadline: grant.deadline,
        status: grant.status,
        eligibleApplicantTypes: (grant.eligible_applicant_types ?? []) as ApplicantType[],
        amountMin: grant.amount_min,
        amountMax: grant.amount_max,
        currency: grant.currency,
      },
      client: {
        jurisdictions: profile.jurisdictions,
        stage: profile.stage,
        annualBudget: profile.annual_budget,
        currency: profile.currency,
      },
      today,
    });

    decided.push({
      grantId: hit.grant_id,
      verdict: decision.verdict,
      relevance: Number(hit.score),
      headline: decision.headline,
      retrieval: { lexicalRank: hit.lexical_rank, vectorRank: hit.vector_rank },
      checks: decision.checks.map((c) => ({
        key: c.key,
        status: c.status,
        isHardGate: c.isHardGate,
        detail: c.detail,
      })),
    });
  }

  await persist(supabase, clientId, decided);

  return {
    clientId,
    retrieved: decided.length,
    eligible: decided.filter((m) => m.verdict === "eligible").length,
    needsInput: decided.filter((m) => m.verdict === "needs_input").length,
    ineligible: decided.filter((m) => m.verdict === "ineligible").length,
    usedLexical: !!lexical,
    usedVector: !!embedding,
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
 */
async function persist(supabase: SupabaseClient, clientId: string, rows: MatchRow[]) {
  const { error: clearError } = await supabase.from("matches").delete().eq("client_id", clientId);
  if (clearError) throw new Error(`could not clear previous matches: ${clearError.message}`);
  if (rows.length === 0) return;

  const now = new Date().toISOString();
  const inserted: Array<{ id: string; grant_id: string }> = [];

  for (let i = 0; i < rows.length; i += 100) {
    const { data, error } = await supabase
      .from("matches")
      .insert(
        rows.slice(i, i + 100).map((row) => ({
          client_id: clientId,
          grant_id: row.grantId,
          verdict: row.verdict,
          relevance: row.relevance,
          retrieval: row.retrieval,
          matched_at: now,
        })),
      )
      .select("id, grant_id");
    if (error) throw new Error(`could not store matches: ${error.message}`);
    inserted.push(...((data ?? []) as Array<{ id: string; grant_id: string }>));
  }

  const matchId = new Map(inserted.map((m) => [m.grant_id, m.id]));
  const checks = rows.flatMap((row) => {
    const id = matchId.get(row.grantId);
    if (!id) return [];
    return row.checks.map((check) => ({
      match_id: id,
      rule_key: check.key,
      status: check.status,
      is_hard_gate: check.isHardGate,
      detail: check.detail,
    }));
  });

  for (let i = 0; i < checks.length; i += 200) {
    const { error } = await supabase.from("eligibility_checks").insert(checks.slice(i, i + 200));
    if (error) throw new Error(`could not store rule results: ${error.message}`);
  }
}
