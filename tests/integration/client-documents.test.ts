import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A client's document register holds where their financial statements and
 * certificates live. Another consultant must not be able to read, change or
 * add to it.
 */

const URL = process.env.SUPABASE_URL ?? "http://localhost:15535";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const stamp = Date.now();
const PASSWORD = "GrantDesk-Test-2026!";

const admin = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Consultant = { client: SupabaseClient; userId: string; clientId: string };

let alice: Consultant;
let bob: Consultant;
let aliceDocId: string;

async function setUp(prefix: string): Promise<Consultant> {
  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const creds = { email: `${prefix}-docs-${stamp}@grantdesk.test`, password: PASSWORD };
  const { error } = await client.auth.signUp(creds);
  if (error && !/already registered/i.test(error.message)) throw error;
  const { data, error: signInError } = await client.auth.signInWithPassword(creds);
  if (signInError) throw signInError;
  const userId = data.user!.id;
  const { data: row, error: clientError } = await client
    .from("clients")
    .insert({ consultant_id: userId, name: `${prefix} docs client ${stamp}`, country: "CA" })
    .select("id")
    .single();
  if (clientError) throw clientError;
  return { client, userId, clientId: (row as { id: string }).id };
}

beforeAll(async () => {
  expect(ANON, "SUPABASE_ANON_KEY must be set — is .env loaded?").not.toBe("");
  alice = await setUp("alice");
  bob = await setUp("bob");
  const { data, error } = await alice.client
    .from("client_documents")
    .insert({
      client_id: alice.clientId,
      kind: "insurance_certificate",
      title: "CGL certificate",
      location: "https://drive.example.org/alice/cgl.pdf",
      issued_on: "2026-01-15",
    })
    .select("id, created_by")
    .single();
  if (error) throw error;
  aliceDocId = (data as { id: string }).id;
  expect((data as { created_by: string }).created_by).toBe(alice.userId);
}, 120_000);

afterAll(async () => {
  const ids = [alice?.clientId, bob?.clientId].filter(Boolean) as string[];
  if (ids.length) await admin.from("clients").delete().in("id", ids);
  for (const who of [alice, bob]) if (who) await admin.auth.admin.deleteUser(who.userId);
});

describe("client_documents isolation", () => {
  it("is invisible to another consultant", async () => {
    const { data: bobSees } = await bob.client
      .from("client_documents")
      .select("id")
      .eq("id", aliceDocId);
    expect(bobSees).toHaveLength(0);
    const { data: aliceSees } = await alice.client
      .from("client_documents")
      .select("id")
      .eq("id", aliceDocId);
    expect(aliceSees).toHaveLength(1);
  }, 60_000);

  it("cannot be changed or deleted by another consultant", async () => {
    await bob.client.from("client_documents").update({ location: "hijacked" }).eq("id", aliceDocId);
    await bob.client.from("client_documents").delete().eq("id", aliceDocId);
    const { data } = await admin
      .from("client_documents")
      .select("location")
      .eq("id", aliceDocId)
      .single();
    expect((data as { location: string }).location).toBe("https://drive.example.org/alice/cgl.pdf");
  }, 60_000);

  it("refuses a document added to someone else's client", async () => {
    const { error } = await bob.client.from("client_documents").insert({
      client_id: alice.clientId,
      kind: "board_list",
      title: "Planted",
      location: "https://example.org/planted",
    });
    expect(error).not.toBeNull();
  }, 60_000);

  it("requires a location", async () => {
    const { error } = await alice.client.from("client_documents").insert({
      client_id: alice.clientId,
      kind: "budget",
      title: "No location",
      location: " ",
    });
    expect(error).not.toBeNull();
  }, 60_000);
});
