import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// handle_new_user (migration 0043): a sign-up joins a tenant only when that
// tenant allows its email domain; anyone else gets a personal tenant.

const URL = process.env.SUPABASE_URL ?? "http://localhost:15535";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stamp = Date.now();
const ALLOWED_DOMAIN = `acme-${stamp}.test`;
const OTHER_DOMAIN = `solo-${stamp}.test`;
const PASSWORD = "GrantDesk-Test-2026!";

let acmeTenantId: string;
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function signUp(email: string): Promise<string> {
  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signUp({ email, password: PASSWORD });
  if (error) throw error;
  const id = data.user?.id;
  if (!id) throw new Error(`sign-up for ${email} returned no user`);
  createdUserIds.push(id);
  return id;
}

async function tenantsOf(userId: string) {
  const { data, error } = await admin
    .from("tenant_members")
    .select("role, tenants(id, slug, subdomain)")
    .eq("user_id", userId);
  if (error) throw error;
  return data as unknown as {
    role: string;
    tenants: { id: string; slug: string; subdomain: string };
  }[];
}

beforeAll(async () => {
  expect(ANON, "SUPABASE_ANON_KEY must be set").not.toBe("");
  expect(SERVICE_KEY, "SUPABASE_SERVICE_ROLE_KEY must be set").not.toBe("");
  const { data, error } = await admin
    .from("tenants")
    .insert({
      slug: `acme-${stamp}`,
      name: "Acme Consulting (test)",
      subdomain: `acme-${stamp}`,
      allowed_email_domains: [ALLOWED_DOMAIN],
    })
    .select("id")
    .single();
  if (error) throw error;
  acmeTenantId = data.id;
  createdTenantIds.push(acmeTenantId);
});

afterAll(async () => {
  for (const id of createdUserIds) {
    for (const m of await tenantsOf(id)) {
      if (m.role === "owner" && !createdTenantIds.includes(m.tenants.id)) {
        createdTenantIds.push(m.tenants.id);
      }
    }
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) throw error;
  }
  if (createdTenantIds.length) {
    const { error } = await admin.from("tenants").delete().in("id", createdTenantIds);
    if (error) throw error;
  }
});

describe("sign-up tenant assignment", () => {
  it("joins the tenant that allows the email domain, as a member", async () => {
    const userId = await signUp(`consultant@${ALLOWED_DOMAIN}`);
    const memberships = await tenantsOf(userId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.tenants.id).toBe(acmeTenantId);
    expect(memberships[0]?.role).toBe("member");
  });

  it("gets a personal tenant of its own when no tenant allows the domain", async () => {
    const userId = await signUp(`Jane.Doe@${OTHER_DOMAIN}`);
    const memberships = await tenantsOf(userId);
    expect(memberships).toHaveLength(1);
    const only = memberships[0]!;
    expect(only.role).toBe("owner");
    expect(only.tenants.id).not.toBe(acmeTenantId);
    expect(only.tenants.id).not.toBe("11111111-1111-1111-1111-111111111111");
    expect(only.tenants.slug).toMatch(/^jane-doe-[0-9a-f]{6}$/);
    expect(only.tenants.subdomain).toBe(only.tenants.slug);
  });
});
