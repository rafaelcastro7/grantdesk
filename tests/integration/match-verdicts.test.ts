import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMatch } from "../../src/server/match";
import { decideEligibility } from "../../src/lib/eligibility";
import { sourceHash } from "../../src/server/ingest";

/**
 * Phase 3's central claim, made falsifiable: a call this client cannot apply
 * for comes back, marked ineligible, with the rule that ruled it out.
 *
 * "Comes back" is the part worth insisting on. Filtering the ineligible ones
 * out in SQL would produce a shorter, cleaner list and destroy the product —
 * a consultant cannot tell a result that was considered and rejected from one
 * that was never in the catalog, and only one of those is a reason to keep
 * looking elsewhere.
 *
 * Runs as the consultant, through row-level security, against the live stack.
 */

const URL = process.env.SUPABASE_URL ?? "http://localhost:15535";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const stamp = Date.now();
const SOURCE_KEY = `test-source-match-${stamp}`;
const CREDS = { email: `match-${stamp}@grantdesk.test`, password: "GrantDesk-Test-2026!" };

const admin = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let consultant: SupabaseClient;
let clientId: string;
const grantId: Record<string, string> = {};

/**
 * A fixture catalog with one grant per verdict, so each assertion below has
 * exactly one row it can be about. Every one shares the client's sector, so
 * retrieval finds all of them and the *rules* are what separate them — which
 * is the thing under test.
 */
const FIXTURES = [
  {
    key: "canadian",
    title: "Ontario Community Environment Fund",
    summary: "Supports nonprofit organizations improving local environment and green space.",
    country: "CA",
    deadline: "2099-12-31",
    eligible_applicant_types: ["nonprofit"],
  },
  {
    key: "foreign",
    title: "State Environment Restoration Program",
    summary: "Supports nonprofit organizations improving local environment and green space.",
    country: "US",
    deadline: "2099-12-31",
    eligible_applicant_types: ["nonprofit"],
  },
  {
    key: "closed",
    title: "Lapsed Environment Stewardship Grant",
    summary: "Supports nonprofit organizations improving local environment and green space.",
    country: "CA",
    deadline: "2020-01-01",
    eligible_applicant_types: ["nonprofit"],
  },
  {
    key: "wrong-form",
    title: "University Environment Research Chair",
    summary: "Supports nonprofit organizations improving local environment and green space.",
    country: "CA",
    deadline: "2099-12-31",
    eligible_applicant_types: ["academic"],
  },
];

beforeAll(async () => {
  expect(ANON, "SUPABASE_ANON_KEY must be set — is .env loaded?").not.toBe("");

  consultant = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signUpError } = await consultant.auth.signUp(CREDS);
  if (signUpError && !/already registered/i.test(signUpError.message)) throw signUpError;
  const { data: session, error: signInError } = await consultant.auth.signInWithPassword(CREDS);
  if (signInError) throw signInError;

  const { data: client, error: clientError } = await consultant
    .from("clients")
    .insert({ consultant_id: session.user!.id, name: `Match fixture ${stamp}`, country: "CA" })
    .select("id")
    .single();
  if (clientError) throw clientError;
  clientId = client.id as string;

  const { error: profileError } = await consultant.from("client_profiles").upsert({
    client_id: clientId,
    sectors: ["environment"],
    jurisdictions: ["CA-ON"],
    stage: "nonprofit",
    capabilities: "We restore ravines and plant trees with volunteers.",
  });
  if (profileError) throw profileError;

  const { data: funder, error: funderError } = await admin
    .from("funders")
    .upsert(
      { name: `Match Fixture Funder ${stamp}`, country: "CA", source_key: SOURCE_KEY },
      { onConflict: "name,country" },
    )
    .select("id")
    .single();
  if (funderError) throw funderError;

  const { data: grants, error: grantError } = await admin
    .from("grants")
    .upsert(
      FIXTURES.map((f) => ({
        funder_id: funder.id,
        title: f.title,
        summary: f.summary,
        url: `https://example.org/${f.key}`,
        country: f.country,
        currency: "CAD",
        deadline: f.deadline,
        language: "en",
        status: "open",
        eligible_applicant_types: f.eligible_applicant_types,
        source_key: SOURCE_KEY,
        source_hash: sourceHash(SOURCE_KEY, f.key),
        last_seen_at: new Date().toISOString(),
      })),
      { onConflict: "source_hash" },
    )
    .select("id, source_hash");
  if (grantError) throw grantError;

  for (const f of FIXTURES) {
    const row = (grants as Array<{ id: string; source_hash: string }>).find(
      (g) => g.source_hash === sourceHash(SOURCE_KEY, f.key),
    );
    grantId[f.key] = row!.id;
  }

  // The run itself, once — every assertion reads what it stored.
  await runMatch(consultant, clientId, { today: new Date("2026-08-16T12:00:00Z"), limit: 200 });
}, 120_000);

afterAll(async () => {
  await admin.from("grants").delete().eq("source_key", SOURCE_KEY);
  await admin.from("funders").delete().eq("source_key", SOURCE_KEY);
  await admin.from("clients").delete().eq("id", clientId);
});

async function verdictFor(key: string) {
  const { data, error } = await consultant
    .from("matches")
    .select(
      "verdict, relevance, retrieval, eligibility_checks(rule_key, status, is_hard_gate, detail)",
    )
    .eq("client_id", clientId)
    .eq("grant_id", grantId[key]!)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as {
    verdict: string;
    relevance: number;
    retrieval: { lexicalRank: number | null; vectorRank: number | null };
    eligibility_checks: Array<{
      rule_key: string;
      status: string;
      is_hard_gate: boolean;
      detail: string;
    }>;
  } | null;
}

describe("verdicts", () => {
  it("clears a call the client can genuinely apply for", async () => {
    const match = await verdictFor("canadian");
    expect(match?.verdict).toBe("eligible");
  });

  it("returns an out-of-jurisdiction call as ineligible, with the reason", async () => {
    const match = await verdictFor("foreign");

    expect(match, "the ruled-out grant must still be returned, not filtered away").not.toBeNull();
    expect(match!.verdict).toBe("ineligible");

    const rule = match!.eligibility_checks.find((c) => c.rule_key === "jurisdiction");
    expect(rule?.status).toBe("fail");
    expect(rule?.is_hard_gate).toBe(true);
    // The reason has to name both sides so the consultant can tell whether the
    // grant is wrong for them or their profile is wrong.
    expect(rule?.detail).toContain("US");
    expect(rule?.detail).toContain("CA-ON");
  });

  it("rules out a closed call and says when it closed", async () => {
    const match = await verdictFor("closed");
    expect(match?.verdict).toBe("ineligible");
    const rule = match!.eligibility_checks.find((c) => c.rule_key === "deadline");
    expect(rule?.detail).toContain("2020-01-01");
  });

  it("rules out a call restricted to a different kind of organization", async () => {
    const match = await verdictFor("wrong-form");
    expect(match?.verdict).toBe("ineligible");
    const rule = match!.eligibility_checks.find((c) => c.rule_key === "applicant_type");
    expect(rule?.status).toBe("fail");
    expect(rule?.detail).toMatch(/universities/);
  });
});

describe("evidence", () => {
  it("stores every rule that ran, not only the one that decided", async () => {
    const match = await verdictFor("foreign");
    const keys = match!.eligibility_checks.map((c) => c.rule_key).sort();
    // Otherwise "why is this here?" is answerable only for the failing rule,
    // and a consultant cannot see what *was* verified.
    //
    // Asked of the engine rather than written out here: the claim is that
    // persistence keeps every rule, and a hand-written list would only ever
    // test that someone remembered to edit this line when adding one.
    const expected = decideEligibility({
      grant: { country: "US" },
      client: { jurisdictions: ["CA"] },
      today: new Date(),
    })
      .checks.map((c) => c.key)
      .sort();
    expect(keys).toEqual(expected);
  });

  it("records how each match was retrieved", async () => {
    const match = await verdictFor("canadian");
    const { lexicalRank, vectorRank } = match!.retrieval;
    expect(
      lexicalRank ?? vectorRank,
      "a match with no retrieval provenance cannot be explained",
    ).not.toBeNull();
  });

  it("re-running replaces verdicts instead of accumulating them", async () => {
    await runMatch(consultant, clientId, { today: new Date("2026-08-16T12:00:00Z"), limit: 200 });

    const { count, error } = await consultant
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId)
      .eq("grant_id", grantId.canadian!);
    if (error) throw new Error(error.message);
    // A stale verdict that contradicts the current profile is worse than none:
    // there is no way to tell which of the two is the real answer.
    expect(count).toBe(1);
  }, 120_000);
});
