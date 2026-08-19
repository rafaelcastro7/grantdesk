import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceHash } from "../../src/server/ingest";
import { fetchPastAwards, loadPastAwards } from "../../src/server/past-awards";

/**
 * Phase 5's decidable half: a submission is recorded once, attributed to the
 * person who confirmed it, and carries whatever they were warned about.
 *
 * The gate's own logic is unit-tested in src/lib/submit-gate.test.ts, where it
 * belongs — it is pure. What can only be proven against a live database is
 * that the record survives, that row-level security keeps it private, and that
 * the same application cannot be recorded as sent twice.
 */

const URL = process.env.SUPABASE_URL ?? "http://localhost:15535";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const stamp = Date.now();
const SOURCE_KEY = `test-source-submit-${stamp}`;
const CREDS = { email: `submit-${stamp}@grantdesk.test`, password: "GrantDesk-Test-2026!" };

const admin = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let consultant: SupabaseClient;
let userId: string;
let clientId: string;
let grantId: string;
let proposalId: string;

beforeAll(async () => {
  expect(ANON, "SUPABASE_ANON_KEY must be set — is .env loaded?").not.toBe("");

  consultant = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signUpError } = await consultant.auth.signUp(CREDS);
  if (signUpError && !/already registered/i.test(signUpError.message)) throw signUpError;
  const { data: session, error: signInError } = await consultant.auth.signInWithPassword(CREDS);
  if (signInError) throw signInError;
  userId = session.user!.id;

  const { data: client } = await consultant
    .from("clients")
    .insert({ consultant_id: userId, name: `Submit fixture ${stamp}`, country: "US" })
    .select("id")
    .single();
  clientId = (client as { id: string }).id;

  const { data: funder } = await admin
    .from("funders")
    .upsert(
      { name: `Submit Fixture Funder ${stamp}`, country: "US", source_key: SOURCE_KEY },
      { onConflict: "name,country" },
    )
    .select("id")
    .single();

  const { data: grant } = await admin
    .from("grants")
    .upsert(
      {
        funder_id: (funder as { id: string }).id,
        title: "Community Health Center Expansion",
        summary: "Supports nonprofit health centers expanding primary care.",
        url: "https://example.org/chc",
        country: "US",
        currency: "USD",
        deadline: "2099-12-31",
        language: "en",
        // A real assistance listing, so the award lookup exercises the live API
        // rather than a shape we invented.
        assistance_listings: ["93.224"],
        source_key: SOURCE_KEY,
        source_hash: sourceHash(SOURCE_KEY, "chc"),
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "source_hash" },
    )
    .select("id")
    .single();
  grantId = (grant as { id: string }).id;

  const { data: proposal } = await consultant
    .from("proposals")
    .upsert({ client_id: clientId, grant_id: grantId }, { onConflict: "client_id, grant_id" })
    .select("id")
    .single();
  proposalId = (proposal as { id: string }).id;
}, 120_000);

afterAll(async () => {
  await admin.from("grants").delete().eq("source_key", SOURCE_KEY);
  await admin.from("funders").delete().eq("source_key", SOURCE_KEY);
  await admin.from("clients").delete().eq("id", clientId);
});

describe("recording a submission", () => {
  it("stores who confirmed it and what they were warned about", async () => {
    const { error } = await consultant.from("submissions").insert({
      proposal_id: proposalId,
      method: "Grants.gov",
      confirmation_number: "GG-12345",
      human_reviewed_by: userId,
      outcome: "awaiting",
      overridden_blockers: [
        { key: "over_limit", detail: "Summary is 40 words over.", isHard: false },
      ],
    });
    expect(error).toBeNull();

    const { data } = await consultant
      .from("submissions")
      .select("human_reviewed_by, outcome, confirmation_number, overridden_blockers")
      .eq("proposal_id", proposalId)
      .single();

    expect(data!.human_reviewed_by).toBe(userId);
    expect(data!.outcome).toBe("awaiting");
    // Six months later, "did we know?" has to be answerable.
    expect((data!.overridden_blockers as Array<{ key: string }>)[0]!.key).toBe("over_limit");
  });

  it("refuses to record the same application as sent twice", async () => {
    // Two submissions would make the tracker disagree with itself about what
    // was sent and when.
    const { error } = await consultant
      .from("submissions")
      .insert({ proposal_id: proposalId, human_reviewed_by: userId });
    expect(error).not.toBeNull();
  });

  it("rejects an outcome outside the tracked set", async () => {
    const { error } = await consultant
      .from("submissions")
      .update({ outcome: "maybe-someday" })
      .eq("proposal_id", proposalId);
    expect(error).not.toBeNull();
  });

  it("keeps one consultant's submissions out of another's reach", async () => {
    const other = createClient(URL, ANON, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const creds = { email: `other-${stamp}@grantdesk.test`, password: "GrantDesk-Test-2026!" };
    await other.auth.signUp(creds);
    await other.auth.signInWithPassword(creds);

    const { data } = await other.from("submissions").select("id").eq("proposal_id", proposalId);
    expect(data).toEqual([]);
  }, 60_000);
});

describe("who won this before", () => {
  it("returns real recipients for a live assistance listing", async () => {
    const awards = await fetchPastAwards("93.224", 5);
    expect(awards.length).toBeGreaterThan(0);
    expect(awards[0]!.recipientName.length).toBeGreaterThan(2);
    // A stable key, or every refresh would duplicate the whole list.
    expect(awards[0]!.externalId).toContain("93.224");
  }, 90_000);

  it("stores them once per assistance listing, and serves the second call from store", async () => {
    // Scoped to the listing rather than the opportunity, deliberately: a
    // program reissues its call every year, and last year's winners are the
    // useful answer. Two opportunities under the same listing therefore share
    // one stored answer instead of each re-querying USAspending.
    const first = await loadPastAwards(admin, grantId);
    expect(first.known).toBe(true);

    const { count: afterFirst } = await admin
      .from("past_awards")
      .select("id", { count: "exact", head: true })
      .eq("assistance_listing", "93.224");
    expect(afterFirst).toBeGreaterThan(0);

    const second = await loadPastAwards(admin, grantId);
    expect(second.known).toBe(true);

    const { count: afterSecond } = await admin
      .from("past_awards")
      .select("id", { count: "exact", head: true })
      .eq("assistance_listing", "93.224");
    // Re-running must not duplicate; the source hash keys each award.
    expect(afterSecond).toBe(afterFirst);
  }, 180_000);

  it("says it does not know, rather than showing an empty list", async () => {
    // "Nobody has ever won this" is a much stronger claim than "we cannot see
    // it", and only one of them is true for a Canadian call.
    const { data: canadian } = await admin
      .from("grants")
      .upsert(
        {
          funder_id: (
            await admin.from("funders").select("id").eq("source_key", SOURCE_KEY).single()
          ).data!.id,
          title: "Canadian Program",
          url: "https://example.org/ca",
          country: "CA",
          language: "en",
          source_key: SOURCE_KEY,
          source_hash: sourceHash(SOURCE_KEY, "ca"),
        },
        { onConflict: "source_hash" },
      )
      .select("id")
      .single();

    const result = await loadPastAwards(admin, (canadian as { id: string }).id);
    expect(result.known).toBe(false);
    if (!result.known) expect(result.reason).toContain("CA");
  }, 60_000);
});
