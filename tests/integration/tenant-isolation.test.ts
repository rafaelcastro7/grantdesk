import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

const URL = process.env.SUPABASE_URL ?? "http://localhost:15535";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stamp = Date.now();
const USER_IIAL = { email: `iial-user-${stamp}@grantdesk.test`, password: "GrantDesk-Test-2026!" };
const USER_ACME = { email: `acme-user-${stamp}@grantdesk.test`, password: "GrantDesk-Test-2026!" };

let tenantIialId: string;
let tenantAcmeId: string;
let clientOfIial: string;

let iialUser: { client: SupabaseClient; userId: string };
let acmeUser: { client: SupabaseClient; userId: string };

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

beforeAll(async () => {
  expect(ANON, "SUPABASE_ANON_KEY must be set").not.toBe("");

  // 1. Ensure IIAL tenant exists
  const { data: iialRow } = await admin.from("tenants").select("id").eq("slug", "iial").single();
  tenantIialId = iialRow ? iialRow.id : "11111111-1111-1111-1111-111111111111";

  // 2. Create second tenant ACME
  const { data: acmeRow, error: acmeErr } = await admin
    .from("tenants")
    .upsert(
      {
        slug: `acme-${stamp}`,
        name: "Acme Consulting Inc",
        subdomain: `acme-${stamp}`,
        branding: { primary_color: "#10b981" },
      },
      { onConflict: "slug" },
    )
    .select("id")
    .single();
  if (acmeErr) throw acmeErr;
  tenantAcmeId = acmeRow.id;

  // 3. Create users
  iialUser = await signUpAndIn(USER_IIAL);
  acmeUser = await signUpAndIn(USER_ACME);

  // 4. Assign memberships: ensure ACME user only belongs to ACME tenant
  await admin.from("tenant_members").delete().eq("user_id", acmeUser.userId);
  await admin.from("tenant_members").insert([
    { tenant_id: tenantIialId, user_id: iialUser.userId, role: "member" },
    { tenant_id: tenantAcmeId, user_id: acmeUser.userId, role: "member" },
  ]);

  // 5. Create client under IIAL tenant
  const { data: clientData, error: clientErr } = await iialUser.client
    .from("clients")
    .insert({
      consultant_id: iialUser.userId,
      tenant_id: tenantIialId,
      name: `IIAL Client ${stamp}`,
      country: "CA",
    })
    .select("id")
    .single();
  if (clientErr) throw clientErr;
  clientOfIial = clientData.id;
}, 60_000);

describe("multi-tenant RLS isolation", () => {
  it("allows IIAL user to read their own client in IIAL tenant", async () => {
    const { data, error } = await iialUser.client
      .from("clients")
      .select("id, name, tenant_id")
      .eq("id", clientOfIial);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.tenant_id).toBe(tenantIialId);
  });

  it("strictly hides IIAL client from ACME tenant user", async () => {
    const { data, error } = await acmeUser.client
      .from("clients")
      .select("id")
      .eq("id", clientOfIial);
    expect(error).toBeNull();
    // Zero rows returned due to RLS tenant boundary filter
    expect(data).toHaveLength(0);
  });

  it("prevents ACME user from writing client profiles to an IIAL client", async () => {
    const { error } = await acmeUser.client
      .from("client_profiles")
      .insert({ client_id: clientOfIial, sectors: ["ai-research"] });
    expect(error).not.toBeNull();
  });

  it("prevents ACME user from creating a client masquerading under IIAL tenant", async () => {
    const { error } = await acmeUser.client.from("clients").insert({
      consultant_id: acmeUser.userId,
      tenant_id: tenantIialId,
      name: "Hostile Client",
      country: "CA",
    });
    expect(error).not.toBeNull();
  });
});
