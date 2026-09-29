/**
 * Narrowing a match list the way a consultant screens: by words, by how soon
 * it closes, by money, by role and by fit. Filters only hide rows from view —
 * the verdicts and their stored reasons are untouched, and the screen always
 * says how many a filter is hiding.
 */

export type FilterableMatch = {
  grants: {
    title: string;
    summary: string | null;
    country: string;
    amount_max: number | null;
    amount_min: number | null;
    deadline: string | null;
    funders: { name: string } | null;
  } | null;
  eligibility_checks: Array<{ rule_key: string; status: string; detail: string }>;
};

export type MatchFilters = {
  text: string;
  closes: "any" | "30" | "90" | "rolling";
  minAmount: number | null;
  role: "any" | "lead" | "funded_partner";
  fitOnly: boolean;
  homeOnly: boolean;
  sort: "relevance" | "deadline" | "amount";
};

export const DEFAULT_MATCH_FILTERS: MatchFilters = {
  text: "",
  closes: "any",
  minAmount: null,
  role: "any",
  fitOnly: false,
  homeOnly: false,
  sort: "relevance",
};

export function matchRole(m: FilterableMatch): "lead" | "funded_partner" | "other" {
  const role = m.eligibility_checks.find((c) => c.rule_key === "role");
  if (role?.status !== "pass") return "other";
  return /funded partner/i.test(role.detail) ? "funded_partner" : "lead";
}

function daysUntil(deadline: string, today: Date): number {
  return Math.ceil((new Date(`${deadline}T23:59:59Z`).getTime() - today.getTime()) / 86_400_000);
}

export function applyMatchFilters<T extends FilterableMatch>(
  rows: readonly T[],
  filters: MatchFilters,
  options: { today: Date; isHome: (country: string | undefined) => boolean },
): T[] {
  const words = filters.text.toLowerCase().split(/\s+/).filter(Boolean);

  const kept = rows.filter((m) => {
    const g = m.grants;
    if (!g) return false;
    if (words.length) {
      const hay = `${g.title} ${g.summary ?? ""} ${g.funders?.name ?? ""}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    if (filters.closes === "rolling" && g.deadline) return false;
    if (filters.closes === "30" || filters.closes === "90") {
      if (!g.deadline) return false;
      const days = daysUntil(g.deadline, options.today);
      if (days < 0 || days > Number(filters.closes)) return false;
    }
    if (filters.minAmount !== null) {
      const best = g.amount_max ?? g.amount_min;
      if (best === null || best < filters.minAmount) return false;
    }
    if (filters.role !== "any" && matchRole(m) !== filters.role) return false;
    if (filters.fitOnly) {
      const fit = m.eligibility_checks.find((c) => c.rule_key === "strategic_fit");
      if (fit?.status !== "pass") return false;
    }
    if (filters.homeOnly && !options.isHome(g.country)) return false;
    return true;
  });

  if (filters.sort === "deadline") {
    return [...kept].sort((a, b) =>
      (a.grants?.deadline ?? "9999-12-31").localeCompare(b.grants?.deadline ?? "9999-12-31"),
    );
  }
  if (filters.sort === "amount") {
    const best = (m: T) => m.grants?.amount_max ?? m.grants?.amount_min ?? -1;
    return [...kept].sort((a, b) => best(b) - best(a));
  }
  return kept;
}

export function isFiltering(filters: MatchFilters): boolean {
  return (
    filters.text.trim() !== "" ||
    filters.closes !== "any" ||
    filters.minAmount !== null ||
    filters.role !== "any" ||
    filters.fitOnly ||
    filters.homeOnly
  );
}
