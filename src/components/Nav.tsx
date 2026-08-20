import { Link, useRouterState } from "@tanstack/react-router";

/**
 * The bar that makes the product navigable.
 *
 * Its absence was a real defect, not a missing polish item: `/catalog` — the
 * page whose entire purpose is to state coverage honestly — had no link
 * pointing at it anywhere in the codebase, so the only way to reach it was to
 * type the URL. A screen nobody can find is a screen that does not exist.
 *
 * Three destinations, matching the three things a consultant does between
 * clients: see what is due, work on a client, check where results come from.
 * The auth screen is excluded because there is nowhere to go from it yet.
 */
const LINKS = [
  { to: "/", label: "Due" },
  { to: "/clients", label: "Clients" },
  { to: "/catalog", label: "Coverage" },
] as const;

export function Nav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (pathname.startsWith("/auth")) return null;

  return (
    <nav
      data-testid="nav"
      aria-label="Main"
      className="border-b border-[var(--color-rule)] bg-[var(--color-surface)]"
    >
      <div className="mx-auto flex max-w-3xl items-baseline gap-6 px-6 py-3">
        <Link to="/" className="text-sm font-semibold tracking-tight">
          IIAL <span className="font-normal text-[var(--color-ink-soft)]">Grant Desk</span>
        </Link>
        <div className="flex gap-4">
          {LINKS.map((link) => {
            // Exact match for the root, prefix for the rest — otherwise "/"
            // is marked current on every page in the app.
            const current = link.to === "/" ? pathname === "/" : pathname.startsWith(link.to);
            return (
              <Link
                key={link.to}
                to={link.to}
                aria-current={current ? "page" : undefined}
                className={
                  current
                    ? "text-sm font-medium text-[var(--color-accent)]"
                    : "text-sm text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                }
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
