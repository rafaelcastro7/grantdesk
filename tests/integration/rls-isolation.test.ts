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
