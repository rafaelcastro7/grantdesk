import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceHash } from "../../src/server/ingest";

/**
 * Owners and internal due dates (migration 0038): only someone on the client's
 * team can be named owner, another consultant cannot see or write them, and a
 * submitted application's assignments are as locked as its text.
 */

const URL = process.env.SUPABASE_URL ?? "http://localhost:15535";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const stamp = Date.now();
const SOURCE_KEY = `test-source-assign-${stamp}`;
const PASSWORD = "GrantDesk-Test-2026!";

const admin = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function signedIn(email: string): Promise<{ db: SupabaseClient; id: string }> {
  const db = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  await db.auth.signUp({ email, password: PASSWORD });
  const { data, error } = await db.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return { db, id: data.user!.id };
}

let owner: { db: SupabaseClient; id: string };
let teammate: { db: SupabaseClient; id: string };
let outsider: { db: SupabaseClient; id: string };
let clientId: string;
let proposalId: string;
let requirementId: string;

beforeAll(async () => {
  expect(ANON, "SUPABASE_ANON_KEY must be set — is .env loaded?").not.toBe("");
  owner = await signedIn(`assign-owner-${stamp}@grantdesk.test`);
  teammate = await signedIn(`assign-mate-${stamp}@grantdesk.test`);
  outsider = await signedIn(`assign-out-${stamp}@grantdesk.test`);

  const { data: client, error: clientError } = await owner.db
    .from("clients")
    .insert({ consultant_id: owner.id, name: `Assign fixture ${stamp}`, country: "CA" })
    .select("id")
    .single();
  if (clientError) throw clientError;
  clientId = (client as { id: string }).id;
  const { error: memberError } = await owner.db
    .from("client_team_members")
    .insert({ client_id: clientId, user_id: teammate.id, added_by: owner.id });
  if (memberError) throw memberError;

  const { data: funder } = await admin
    .from("funders")
    .upsert(
      { name: `Assign Fixture Funder ${stamp}`, country: "CA", source_key: SOURCE_KEY },
      { onConflict: "name,country" },
    )
    .select("id")
    .single();
  const { data: grant } = await admin
    .from("grants")
    .upsert(
      {
        funder_id: (funder as { id: string }).id,
        title: "Assignment fixture call",
        url: "https://example.org/assign",
        country: "CA",
        currency: "CAD",
        deadline: "2099-12-31",
        language: "en",
        source_key: SOURCE_KEY,
        source_hash: sourceHash(SOURCE_KEY, "assign"),
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "source_hash" },
    )
    .select("id")
    .single();
  const grantId = (grant as { id: string }).id;

  const { data: requirement, error: reqError } = await admin
    .from("requirements")
    .insert({ grant_id: grantId, label: "Budget Narrative", kind: "section", sort_order: 0 })
    .select("id")
    .single();
  if (reqError) throw reqError;
  requirementId = (requirement as { id: string }).id;

  const { data: proposal } = await owner.db
    .from("proposals")
    .upsert({ client_id: clientId, grant_id: grantId }, { onConflict: "client_id, grant_id" })
    .select("id")
    .single();
  proposalId = (proposal as { id: string }).id;
}, 120_000);

afterAll(async () => {
  await admin.from("clients").delete().eq("id", clientId);
  await admin.from("grants").delete().eq("source_key", SOURCE_KEY);
  await admin.from("funders").delete().eq("source_key", SOURCE_KEY);
  for (const who of [owner, teammate, outsider]) {
    if (who) await admin.auth.admin.deleteUser(who.id);
  }
});

describe("requirement assignments", () => {
  it("lets the owner assign a teammate with a due date", async () => {
    const { error } = await owner.db.from("requirement_assignments").upsert(
      {
        proposal_id: proposalId,
        requirement_id: requirementId,
        owner_id: teammate.id,
        due_on: "2099-10-01",
      },
      { onConflict: "proposal_id, requirement_id" },
    );
    expect(error).toBeNull();
    const { data } = await teammate.db
      .from("requirement_assignments")
      .select("owner_id, due_on")
      .eq("proposal_id", proposalId)
      .single();
    expect(data).toEqual({ owner_id: teammate.id, due_on: "2099-10-01" });
  });

  it("refuses an owner who is not on the client's team", async () => {
    const { error } = await owner.db
      .from("requirement_assignments")
      .update({ owner_id: outsider.id })
      .eq("proposal_id", proposalId)
      .eq("requirement_id", requirementId);
    expect(error?.message).toMatch(/on this client's team/);
  });

  it("names the team to its members and to nobody else", async () => {
    const { data: mine } = await teammate.db.rpc("client_team_roster", { target: clientId });
    expect((mine as Array<{ user_id: string }>).map((m) => m.user_id).sort()).toEqual(
      [owner.id, teammate.id].sort(),
    );
    const { data: theirs } = await outsider.db.rpc("client_team_roster", { target: clientId });
    expect(theirs).toEqual([]);
  });

  it("hides assignments from a consultant outside the client", async () => {
    const { data } = await outsider.db
      .from("requirement_assignments")
      .select("owner_id")
      .eq("proposal_id", proposalId);
    expect(data).toEqual([]);
  });

  it("locks assignments once the application is submitted", async () => {
    const { error: sendError } = await owner.db
      .from("submissions")
      .insert({ proposal_id: proposalId, human_reviewed_by: owner.id });
    expect(sendError).toBeNull();
    const { error } = await owner.db
      .from("requirement_assignments")
      .update({ due_on: "2099-11-01" })
      .eq("proposal_id", proposalId)
      .eq("requirement_id", requirementId);
    expect(error?.message).toMatch(/submitted and is locked/);
  });
});
