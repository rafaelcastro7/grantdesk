/**
 * Tenant resolution and isolation utilities for GrantDesk.
 *
 * Supports subdomain routing (e.g. iial.grantdesk.app, iial.localhost:5180),
 * query parameters (?tenant=iial), and custom headers (x-tenant-slug).
 */

export interface TenantBranding {
  name: string;
  shortName: string;
  slug: string;
  subdomain: string;
  tagline: string;
  primaryColor: string;
  accentColor: string;
  /** Null when the tenant has not supplied a logo; never another tenant's. */
  logoUrl: string | null;
  logoInverseUrl: string | null;
}

export const DEFAULT_TENANT_SLUG = "iial";

export const KNOWN_TENANTS: Record<string, TenantBranding> = {
  iial: {
    slug: "iial",
    subdomain: "iial",
    name: "Institute of Innovation and Advanced Learning",
    shortName: "IIAL",
    tagline: "AI-Native Grant Intelligence & Proposal Studio",
    primaryColor: "#0ea5e9",
    accentColor: "#0284c7",
    logoUrl: "/brand/iial-logo.png",
    logoInverseUrl: "/brand/iial-logo-inverse.png",
  },
  acme: {
    slug: "acme",
    subdomain: "acme",
    name: "Acme Consulting Group",
    shortName: "Acme",
    tagline: "Strategic Funding & Research Advisory",
    primaryColor: "#10b981",
    accentColor: "#059669",
    logoUrl: null,
    logoInverseUrl: null,
  },
};

/**
 * Parses the tenant slug from host string, URL search params, or explicit headers.
 */
export function resolveTenantSlug({
  hostname,
  searchParams,
  headers,
}: {
  hostname?: string | null;
  searchParams?: URLSearchParams | null;
  headers?: Headers | Record<string, string | string[] | undefined> | null;
} = {}): string {
  // 1. Query parameter override (highest precedence for dev and manual switching)
  if (searchParams) {
    const fromParam = searchParams.get("tenant");
    if (fromParam && fromParam.trim()) {
      return fromParam.trim().toLowerCase();
    }
  }

  // 2. Header override (e.g., in server-side calls or reverse proxies)
  if (headers) {
    let headerVal: string | undefined;
    if (typeof (headers as Headers).get === "function") {
      headerVal = (headers as Headers).get("x-tenant-slug") ?? undefined;
    } else {
      const rec = headers as Record<string, string | string[] | undefined>;
      const raw = rec["x-tenant-slug"] ?? rec["X-Tenant-Slug"];
      headerVal = Array.isArray(raw) ? raw[0] : raw;
    }
    if (headerVal && headerVal.trim()) {
      return headerVal.trim().toLowerCase();
    }
  }

  // 3. Subdomain extraction from hostname (e.g., iial.grantdesk.app, iial.localhost)
  if (hostname) {
    const cleanHost = hostname.split(":")[0]?.toLowerCase() ?? "";
    // Match <subdomain>.grantdesk.<tld> or <subdomain>.localhost
    const parts = cleanHost.split(".");
    if (parts.length >= 2) {
      const candidate = parts[0];
      if (candidate && candidate !== "www" && candidate !== "app" && candidate !== "api") {
        return candidate;
      }
    }
  }

  return DEFAULT_TENANT_SLUG;
}

/**
 * Returns tenant branding metadata, falling back to IIAL defaults if custom.
 */
export function getTenantBranding(slug: string): TenantBranding {
  const normalized = slug.toLowerCase().trim();
  if (KNOWN_TENANTS[normalized]) {
    return KNOWN_TENANTS[normalized];
  }
  return {
    slug: normalized,
    subdomain: normalized,
    name: normalized.toUpperCase() + " Grant Workspace",
    shortName: normalized.toUpperCase(),
    tagline: "Secure Multi-Tenant Grant Desk",
    primaryColor: "#0ea5e9",
    accentColor: "#0284c7",
    logoUrl: null,
    logoInverseUrl: null,
  };
}
