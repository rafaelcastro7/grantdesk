import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getTenantBranding, resolveTenantSlug } from "@/lib/tenant";
import { supabase } from "@/lib/supabase";

const LINKS: Array<{ to: string; label: string }> = [
  { to: "/", label: "What is due" },
  { to: "/clients", label: "Clients" },
  { to: "/catalog", label: "Funder Coverage" },
];

/**
 * The workspace shown is the one the signed-in user actually belongs to.
 * The hostname only decides branding before sign-in; showing a member of
 * one tenant another tenant's name would misstate whose data they see.
 */
export function Nav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [tenantSlug, setTenantSlug] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  // Only decides whether the link shows; the page and database enforce the role.
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    const fromHost = resolveTenantSlug({
      hostname: window.location.hostname,
      searchParams: new URLSearchParams(window.location.search),
    });
    void (async () => {
      const { data: session } = await supabase().auth.getSession();
      if (!cancelled) setSignedIn(!!session.session);
      if (!session.session) {
        if (!cancelled) setTenantSlug(fromHost);
        return;
      }
      const { data } = await supabase()
        .from("tenant_members")
        .select("role, tenants(slug)")
        .eq("user_id", session.session.user.id)
        .limit(1)
        .maybeSingle();
      const row = data as { role: string; tenants: { slug: string } | null } | null;
      const member = row?.tenants?.slug;
      if (!cancelled) {
        setTenantSlug(member ?? fromHost);
        setIsAdmin(row?.role === "owner" || row?.role === "admin");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (pathname.startsWith("/auth")) return null;
  const branding = getTenantBranding(tenantSlug ?? "iial");

  return (
    <nav
      data-testid="nav"
      aria-label="Main"
      className="border-b border-[var(--color-rule)] bg-[var(--color-surface)] shadow-xs print:hidden sticky top-0 z-40 backdrop-blur-md bg-opacity-95"
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <Link to="/" className="flex items-center gap-3 group">
            {branding.logoUrl && tenantSlug && (
              <img
                src={branding.logoUrl}
                alt={branding.name}
                width={161}
                height={49}
                className="h-7 w-auto self-center dark:hidden transition-transform group-hover:scale-102"
              />
            )}
            {branding.logoInverseUrl && tenantSlug && (
              <img
                src={branding.logoInverseUrl}
                alt=""
                aria-hidden="true"
                width={162}
                height={51}
                className="hidden h-7 w-auto self-center dark:block transition-transform group-hover:scale-102"
              />
            )}
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-[var(--color-ink)] leading-tight">
                GrantDesk
              </span>
              <span className="text-[11px] text-[var(--color-ink-soft)] tracking-wider uppercase font-medium">
                {branding.shortName} Workspace
              </span>
            </div>
          </Link>

          {tenantSlug && (
            <div
              data-testid="tenant-badge"
              className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border border-[var(--color-rule)] text-[var(--color-ink-soft)]"
            >
              Workspace: <strong>{branding.shortName}</strong>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-1 sm:gap-2">
            {[
              ...LINKS,
              ...(signedIn && isAdmin ? [{ to: "/settings/email", label: "Email settings" }] : []),
            ].map((link) => {
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
                </Link>
              );
            })}
          </div>
          {signedIn && (
            <button
              type="button"
              onClick={async () => {
                await supabase().auth.signOut();
                window.location.assign("/auth");
              }}
              className="px-3 py-1.5 rounded-md text-sm text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
            >
              Sign out
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
