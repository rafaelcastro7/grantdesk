import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The product claim for a consultant tool is that one client's material is
 * unreachable from another consultant's session, enforced by the database.
 * This is the test that makes that claim falsifiable.
 *
 * It runs against the live local stack (bun run db:up && bun run db:migrate).
 */

const URL = process.env.SUPABASE_URL ?? "http://localhost:15535";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stamp = Date.now();
const CONSULTANT_A = { email: `a-${stamp}@grantdesk.test`, password: "GrantDesk-Test-2026!" };
const CONSULTANT_B = { email: `b-${stamp}@grantdesk.test`, password: "GrantDesk-Test-2026!" };

async function signUpAndIn(creds: { email: string; password: string }) {
  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signUpError } = await client.auth.signUp(creds);
  if (signUpError && !/already registered/i.test(signUpError.message)) throw signUpError;
  const { data, error } = await client.auth.signInWithPassword(creds);
  if (error) throw error;
  return { client, userId: data.user!.id };
}

let a: { client: SupabaseClient; userId: string };
let b: { client: SupabaseClient; userId: string };
let clientOfA: string;

beforeAll(async () => {
  expect(ANON, "SUPABASE_ANON_KEY must be set — is .env loaded?").not.toBe("");
  a = await signUpAndIn(CONSULTANT_A);
  b = await signUpAndIn(CONSULTANT_B);

  const { data, error } = await a.client
    .from("clients")
    .insert({ consultant_id: a.userId, name: `Client of A ${stamp}`, country: "CA" })
    .select("id")
    .single();
  if (error) throw error;
  clientOfA = data.id as string;
}, 60_000);

describe("row-level isolation between consultants", () => {
  it("creates the consultant row automatically on signup", async () => {
    // Without the auth.users trigger there is no row to resolve ownership
    // against, and every policy below would deny by accident rather than by
    // design — which would make this whole suite pass for the wrong reason.
    const { data, error } = await a.client.from("consultants").select("id").eq("id", a.userId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("lets a consultant read their own client", async () => {
    const { data, error } = await a.client.from("clients").select("id").eq("id", clientOfA);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("hides that client from another consultant", async () => {
    const { data, error } = await b.client.from("clients").select("id").eq("id", clientOfA);
    expect(error).toBeNull();
    // RLS filters rather than errors: the row is simply not in B's universe.
    expect(data).toHaveLength(0);
  });

  it("refuses to let a consultant create a client owned by someone else", async () => {
    const { error } = await b.client
      .from("clients")
      .insert({ consultant_id: a.userId, name: "Smuggled", country: "CA" });
    expect(error, "WITH CHECK should have rejected this insert").not.toBeNull();
  });

  it("refuses to let another consultant write a profile for that client", async () => {
    const { error } = await b.client
      .from("client_profiles")
      .insert({ client_id: clientOfA, sectors: ["technology"] });
    expect(error, "owns_client() should have rejected this insert").not.toBeNull();
  });

  it("keeps the shared catalog readable by any signed-in consultant", async () => {
    // Isolation must not accidentally wall off reference data; both sides of
    // the boundary need proving, not just the deny side.
    const { error } = await b.client.from("grants").select("id").limit(1);
    expect(error).toBeNull();
  });
});

describe("client team membership", () => {
  it("lets a consultant read a client they just created, via INSERT ... RETURNING", async () => {
    // The regression this suite exists to catch. owns_client() re-queries
    // clients by id, and a self-referential subquery on the table a statement
    // is writing to cannot see that statement's own new row — Postgres
    // evaluates it against the snapshot from before the statement started.
    // The first version of the team-sharing policy routed clients' own SELECT
    // policy through owns_client() for consistency with every other table,
    // which broke exactly this: the insert succeeded and its own RETURNING
    // clause then failed RLS, because every client creation in the app does
    // .insert(...).select("id") in one round trip.
    const { data, error } = await a.client
      .from("clients")
      .insert({ consultant_id: a.userId, name: `Returning check ${stamp}`, country: "CA" })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
  });

  it("finds a colleague's id by email, and nothing for an unknown one", async () => {
    const { data: found, error } = await a.client.rpc("find_consultant_by_email", {
      target_email: CONSULTANT_B.email,
    });
    expect(error).toBeNull();
    expect(found).toBe(b.userId);

    const { data: missing } = await a.client.rpc("find_consultant_by_email", {
      target_email: `nobody-${stamp}@grantdesk.test`,
    });
    expect(missing).toBeNull();
  });

  it("adds a colleague to the team and opens every downstream table to them", async () => {
    const { error: addError } = await a.client
      .from("client_team_members")
      .insert({ client_id: clientOfA, user_id: b.userId, added_by: a.userId });
    expect(addError).toBeNull();

    // Not just the clients row — the whole reason owns_client() is one choke
    // point is that every table under it opens at once.
    const { data: seen, error: readError } = await b.client
      .from("clients")
      .select("id")
      .eq("id", clientOfA);
    expect(readError).toBeNull();
    expect(seen).toHaveLength(1);

    const { error: profileError } = await b.client
      .from("client_profiles")
      .upsert({ client_id: clientOfA, sectors: ["technology"] });
    expect(profileError).toBeNull();
  });

  it("refuses to let a non-owner team member add a third person", async () => {
    // A member being able to expand who has access is the one thing this
    // design deliberately withholds from members — otherwise anyone added to
    // one shared client could silently add anyone else.
    const c = await signUpAndIn({
      email: `c-${stamp}@grantdesk.test`,
      password: "GrantDesk-Test-2026!",
    });
    const { error } = await b.client
      .from("client_team_members")
      .insert({ client_id: clientOfA, user_id: c.userId, added_by: b.userId });
    expect(error, "a non-owner insert should have been rejected").not.toBeNull();
  });

  it("refuses to let a member reassign ownership through an update", async () => {
    // Enforced by the pin_client_ownership trigger, not a WITH CHECK
    // subquery — the subquery form hits the exact same same-command
    // visibility trap as the INSERT ... RETURNING bug above. Prove the actual
    // outcome: after B's update, A is still the owner of record.
    await b.client.from("clients").update({ consultant_id: b.userId }).eq("id", clientOfA);
    const { data } = await admin
      .from("clients")
      .select("consultant_id")
      .eq("id", clientOfA)
      .single();
    expect((data as { consultant_id: string }).consultant_id).toBe(a.userId);
  });

  it("lets a member leave, but not remove someone else", async () => {
    const stranger = await signUpAndIn({
      email: `d-${stamp}@grantdesk.test`,
      password: "GrantDesk-Test-2026!",
    });
    await a.client
      .from("client_team_members")
      .insert({ client_id: clientOfA, user_id: stranger.userId, added_by: a.userId });

    await b.client
      .from("client_team_members")
      .delete()
      .eq("client_id", clientOfA)
      .eq("user_id", stranger.userId);
    // RLS filters the delete's target rows rather than erroring on a delete
    // that would touch none — the outcome to check is that the row survives.
    const { data: stillThere } = await admin
      .from("client_team_members")
      .select("user_id")
      .eq("client_id", clientOfA)
      .eq("user_id", stranger.userId);
    expect(stillThere).toHaveLength(1);

    const { error: leaveError } = await b.client
      .from("client_team_members")
      .delete()
      .eq("client_id", clientOfA)
      .eq("user_id", b.userId);
    expect(leaveError).toBeNull();

    const { data: bAccessNow } = await b.client.from("clients").select("id").eq("id", clientOfA);
    expect(bAccessNow).toHaveLength(0);
  });
});
