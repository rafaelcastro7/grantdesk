import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getTenantBranding, resolveTenantSlug } from "@/lib/tenant";

/**
 * Top navigation bar with multi-tenant workspace badge,
 * contextual active routes, and active deadline indicator.
 */
const LINKS: Array<{ to: string; label: string; badge?: string }> = [
  { to: "/", label: "Due Radar", badge: "Live" },
  { to: "/clients", label: "Clients" },
  { to: "/catalog", label: "Funder Coverage" },
];

export function Nav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [tenantSlug, setTenantSlug] = useState<string>("iial");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const search = new URLSearchParams(window.location.search);
      const resolved = resolveTenantSlug({
        hostname: window.location.hostname,
        searchParams: search,
      });
      setTenantSlug(resolved);
    }
  }, [pathname]);

  const branding = getTenantBranding(tenantSlug);

  if (pathname.startsWith("/auth")) return null;

  return (
    <nav
      data-testid="nav"
      aria-label="Main"
      className="border-b border-[var(--color-rule)] bg-[var(--color-surface)] shadow-xs print:hidden sticky top-0 z-40 backdrop-blur-md bg-opacity-95"
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <Link to="/" className="flex items-center gap-3 group">
            <img
              src={branding.logoUrl}
              alt={branding.name}
              width={161}
              height={49}
              className="h-7 w-auto self-center dark:hidden transition-transform group-hover:scale-102"
            />
            <img
              src={branding.logoInverseUrl}
              alt=""
              aria-hidden="true"
              width={162}
              height={51}
              className="hidden h-7 w-auto self-center dark:block transition-transform group-hover:scale-102"
            />
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-[var(--color-ink)] leading-tight">
                GrantDesk
              </span>
              <span className="text-[11px] text-[var(--color-ink-soft)] tracking-wider uppercase font-medium">
                {branding.shortName} Workspace
              </span>
            </div>
          </Link>

          {/* Tenant Status Badge */}
          <div
            data-testid="tenant-badge"
            className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border border-sky-500/20 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse" />
            <span>
              Tenant: <strong>{branding.shortName}</strong>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-1 sm:gap-2">
            {LINKS.map((link) => {
              const current = link.to === "/" ? pathname === "/" : pathname.startsWith(link.to);
              return (
                <Link
                  key={link.to}
                  to={link.to}
                  aria-current={current ? "page" : undefined}
                  className={
                    current
                      ? "px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--color-surface-hover)] text-[var(--color-accent)] transition-colors"
                      : "px-3 py-1.5 rounded-md text-sm font-medium text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)] transition-colors"
                  }
                >
                  {link.label}
                  {link.badge && (
                    <span className="ml-1.5 text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                      {link.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}
