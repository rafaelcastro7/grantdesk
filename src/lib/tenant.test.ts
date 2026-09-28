import { describe, expect, it } from "vitest";
import { getTenantBranding, resolveTenantSlug, DEFAULT_TENANT_SLUG } from "./tenant";

describe("tenant resolution & isolation", () => {
  it("resolves default tenant when no host or params are given", () => {
    expect(resolveTenantSlug()).toBe(DEFAULT_TENANT_SLUG);
  });

  it("resolves subdomain from production domain", () => {
    expect(resolveTenantSlug({ hostname: "iial.grantdesk.app" })).toBe("iial");
    expect(resolveTenantSlug({ hostname: "acme.grantdesk.ca" })).toBe("acme");
  });

  it("resolves subdomain on localhost development environments", () => {
    expect(resolveTenantSlug({ hostname: "iial.localhost:5180" })).toBe("iial");
    expect(resolveTenantSlug({ hostname: "acme.localhost" })).toBe("acme");
  });

  it("ignores reserved subdomains like www or app", () => {
    expect(resolveTenantSlug({ hostname: "www.grantdesk.app" })).toBe(DEFAULT_TENANT_SLUG);
    expect(resolveTenantSlug({ hostname: "app.grantdesk.app" })).toBe(DEFAULT_TENANT_SLUG);
  });

  it("prioritizes query param override over hostname for easy testing", () => {
    const params = new URLSearchParams("tenant=acme");
    expect(resolveTenantSlug({ hostname: "iial.grantdesk.app", searchParams: params })).toBe(
      "acme",
    );
  });

  it("resolves header x-tenant-slug when provided", () => {
    const headers = new Headers();
    headers.set("x-tenant-slug", "iial");
    expect(resolveTenantSlug({ headers })).toBe("iial");
  });

  it("returns rich branding for known tenants", () => {
    const iial = getTenantBranding("iial");
    expect(iial.shortName).toBe("IIAL");
    expect(iial.name).toContain("Institute of Innovation");
    expect(iial.primaryColor).toBe("#0ea5e9");
  });

  it("provides dynamic fallback branding for custom tenants", () => {
    const custom = getTenantBranding("techcorp");
    expect(custom.slug).toBe("techcorp");
    expect(custom.shortName).toBe("TECHCORP");
    expect(custom.name).toContain("TECHCORP");
  });
});
