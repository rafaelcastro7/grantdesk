import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceHash } from "../../src/server/ingest";

/**
 * Two consultants, one call.
 *
 * The catalog is shared, and so are the requirements read off a call — which
 * makes them the one place in this schema where one consultant's action can
 * reach another's work. Re-reading a call replaces what a previous read
 * extracted, and the first version of that decided what was safe to delete by
 * reading `proposal_sections` through the caller's own connection. Row-level
 * security means the caller sees only their own sections, so it deleted
 * requirements another consultant had already drafted against; their section
 * survived in the table but lost its link, and the proposal screen maps
 * sections by requirement, so it disappeared from their screen with no error
 * anywhere.
 *
 * These tests exist because nothing else in the suite has two consultants
 * touching the same row.
 */

const URL = process.env.SUPABASE_URL ?? "http://localhost:15535";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const stamp = Date.now();
const SOURCE_KEY = `test-source-shared-${stamp}`;
const PASSWORD = "GrantDesk-Test-2026!";

const admin = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Consultant = { client: SupabaseClient; userId: string; clientId: string; proposalId: string };

let grantId: string;
let alice: Consultant;
let bob: Consultant;
let sharedRequirementId: string;

async function signUp(prefix: string): Promise<{ client: SupabaseClient; userId: string }> {
  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const creds = { email: `${prefix}-${stamp}@grantdesk.test`, password: PASSWORD };
  const { error } = await client.auth.signUp(creds);
  if (error && !/already registered/i.test(error.message)) throw error;
  const { data, error: signInError } = await client.auth.signInWithPassword(creds);
  if (signInError) throw signInError;
  return { client, userId: data.user!.id };
}

async function setUpConsultant(prefix: string): Promise<Consultant> {
  const { client, userId } = await signUp(prefix);
  const { data: clientRow } = await client
    .from("clients")
    .insert({ consultant_id: userId, name: `${prefix} client ${stamp}`, country: "CA" })
    .select("id")
    .single();
  const clientId = (clientRow as { id: string }).id;

  const { data: proposal } = await client
    .from("proposals")
    .upsert({ client_id: clientId, grant_id: grantId }, { onConflict: "client_id, grant_id" })
    .select("id")
    .single();

  return { client, userId, clientId, proposalId: (proposal as { id: string }).id };
}

beforeAll(async () => {
  expect(ANON, "SUPABASE_ANON_KEY must be set — is .env loaded?").not.toBe("");

  const { data: funder } = await admin
    .from("funders")
    .upsert(
      { name: `Shared Fixture Funder ${stamp}`, country: "CA", source_key: SOURCE_KEY },
      { onConflict: "name,country" },
    )
    .select("id")
    .single();

  const { data: grant } = await admin
    .from("grants")
    .upsert(
      {
        funder_id: (funder as { id: string }).id,
        title: "Shared Call",
        url: "https://example.org/shared",
        country: "CA",
        language: "en",
        source_key: SOURCE_KEY,
        source_hash: sourceHash(SOURCE_KEY, "shared"),
      },
      { onConflict: "source_hash" },
    )
    .select("id")
    .single();
  grantId = (grant as { id: string }).id;

  alice = await setUpConsultant("alice");
  bob = await setUpConsultant("bob");

  // A requirement that came from a previous read of the call. Extracted rows
  // are shared catalog data and only the server writes them.
  const { data: requirement, error } = await admin
    .from("requirements")
    .upsert(
      {
        grant_id: grantId,
        label: "Organizational Capacity",
        kind: "section",
        extracted_from: "https://example.org/shared",
        extracted_at: new Date().toISOString(),
        sort_order: 0,
      },
      { onConflict: "grant_id, label, client_id" },
    )
    .select("id")
    .single();
  if (error) throw error;
  sharedRequirementId = (requirement as { id: string }).id;
}, 120_000);

afterAll(async () => {
  await admin.from("grants").delete().eq("source_key", SOURCE_KEY);
  await admin.from("funders").delete().eq("source_key", SOURCE_KEY);
  await admin.from("clients").delete().in("id", [alice.clientId, bob.clientId]);
});

describe("re-reading a call that another consultant is writing against", () => {
  it("keeps a requirement someone else has drafted a section for", async () => {
    // Bob writes against it. Alice cannot see that this happened, and that is
    // exactly why the check cannot be made from Alice's connection.
    const { error: writeError } = await bob.client.from("proposal_sections").upsert(
      {
        proposal_id: bob.proposalId,
        requirement_id: sharedRequirementId,
        heading: "Organizational Capacity",
        content: "Bob's draft, which he would like to keep.",
        word_count: 8,
      },
      { onConflict: "proposal_id, requirement_id" },
    );
    expect(writeError).toBeNull();

    // The blindness this whole function exists to work around, demonstrated:
    // Alice's own connection cannot see that Bob wrote anything, so any safety
    // check made from here is guaranteed to get the wrong answer.
    const { data: aliceSees } = await alice.client
      .from("proposal_sections")
      .select("id")
      .eq("requirement_id", sharedRequirementId);
    const { data: reallyThere } = await admin
      .from("proposal_sections")
      .select("id")
      .eq("requirement_id", sharedRequirementId);
    expect(aliceSees).toHaveLength(0);
    expect(reallyThere).toHaveLength(1);

    // Alice re-reads the call.
    const { error: rpcError } = await alice.client.rpc("replace_extracted_requirements", {
      target_grant: grantId,
    });
    expect(rpcError).toBeNull();

    const { data: survived } = await admin
      .from("requirements")
      .select("id")
      .eq("id", sharedRequirementId);
    expect(survived, "Alice's re-read deleted a requirement Bob had drafted against").toHaveLength(
      1,
    );

    // And Bob's section still points at it, so it is still on his screen.
    const { data: section } = await bob.client
      .from("proposal_sections")
      .select("requirement_id, content")
      .eq("proposal_id", bob.proposalId)
      .single();
    expect(section!.requirement_id).toBe(sharedRequirementId);
    expect(section!.content).toContain("Bob's draft");
  }, 60_000);

  it("still removes an extracted requirement nobody is writing against", async () => {
    // The dedup this replace exists for has to keep working, or a re-read goes
    // back to piling near-synonyms on top of each other.
    const { data: orphan } = await admin
      .from("requirements")
      .upsert(
        {
          grant_id: grantId,
          label: "Applicant Status",
          kind: "eligibility",
          extracted_from: "https://example.org/shared",
          sort_order: 1,
        },
        { onConflict: "grant_id, label, client_id" },
      )
      .select("id")
      .single();

    await alice.client.rpc("replace_extracted_requirements", { target_grant: grantId });

    const { data: gone } = await admin
      .from("requirements")
      .select("id")
      .eq("id", (orphan as { id: string }).id);
    expect(gone).toHaveLength(0);
  }, 60_000);

  it("never touches a heading the consultant typed themselves", async () => {
    // Typed from the funder's form, so it has no extracted_from. Losing it on
    // a re-read would delete the consultant's own input.
    const { data: typed } = await alice.client
      .from("requirements")
      .upsert(
        {
          grant_id: grantId,
          client_id: alice.clientId,
          label: "Budget Narrative",
          kind: "section",
          sort_order: 2,
        },
        { onConflict: "grant_id, label, client_id" },
      )
      .select("id")
      .single();

    await alice.client.rpc("replace_extracted_requirements", { target_grant: grantId });

    const { data: survived } = await admin
      .from("requirements")
      .select("id")
      .eq("id", (typed as { id: string }).id);
    expect(survived).toHaveLength(1);
  }, 60_000);
});

describe("a heading typed for one client", () => {
  it("is invisible to another consultant and cannot be overwritten by them", async () => {
    await alice.client.from("requirements").upsert(
      {
        grant_id: grantId,
        client_id: alice.clientId,
        label: "Alice Only Heading",
        kind: "section",
        word_limit: 300,
      },
      { onConflict: "grant_id, label, client_id" },
    );

    const { data: bobSees } = await bob.client
      .from("requirements")
      .select("id")
      .eq("grant_id", grantId)
      .eq("label", "Alice Only Heading");
    expect(bobSees).toHaveLength(0);

    // Bob can neither write a shared row nor one owned by Alice's client.
    const shared = await bob.client
      .from("requirements")
      .insert({ grant_id: grantId, label: "Injected", kind: "section" });
    expect(shared.error).not.toBeNull();
    const intoAlice = await bob.client
      .from("requirements")
      .insert({ grant_id: grantId, client_id: alice.clientId, label: "Injected", kind: "section" });
    expect(intoAlice.error).not.toBeNull();
  }, 60_000);
});
