import { describe, expect, it } from "vitest";
import {
  applyMatchFilters,
  DEFAULT_MATCH_FILTERS,
  matchRole,
  type FilterableMatch,
} from "./match-filters";

const TODAY = new Date("2026-09-29T12:00:00Z");
const opts = { today: TODAY, isHome: (c: string | undefined) => c === "CA" };

function row(over: {
  title?: string;
  country?: string;
  deadline?: string | null;
  amount?: number | null;
  role?: string;
  fit?: "pass" | "unknown";
}): FilterableMatch {
  return {
    grants: {
      title: over.title ?? "Call",
      summary: null,
      country: over.country ?? "CA",
      amount_max: over.amount ?? null,
      amount_min: null,
      deadline: over.deadline === undefined ? "2026-12-31" : over.deadline,
      funders: { name: "Funder" },
    },
    eligibility_checks: [
      ...(over.role ? [{ rule_key: "role", status: "pass", detail: over.role }] : []),
      { rule_key: "strategic_fit", status: over.fit ?? "unknown", detail: "" },
    ],
  };
}

describe("match filters", () => {
  it("matches every word of the search in title, summary or funder", () => {
    const rows = [row({ title: "Smart Cities Challenge" }), row({ title: "Bridge repair" })];
    const out = applyMatchFilters(rows, { ...DEFAULT_MATCH_FILTERS, text: "smart cities" }, opts);
    expect(out.map((r) => r.grants?.title)).toEqual(["Smart Cities Challenge"]);
  });

  it("keeps only calls closing inside the window, and rolling ones on request", () => {
    const rows = [
      row({ title: "soon", deadline: "2026-10-15" }),
      row({ title: "later", deadline: "2027-03-01" }),
      row({ title: "rolling", deadline: null }),
    ];
    expect(
      applyMatchFilters(rows, { ...DEFAULT_MATCH_FILTERS, closes: "30" }, opts).map(
        (r) => r.grants?.title,
      ),
    ).toEqual(["soon"]);
    expect(
      applyMatchFilters(rows, { ...DEFAULT_MATCH_FILTERS, closes: "rolling" }, opts).map(
        (r) => r.grants?.title,
      ),
    ).toEqual(["rolling"]);
  });

  it("drops calls with no published amount when a minimum is set", () => {
    const rows = [row({ title: "big", amount: 100000 }), row({ title: "unknown", amount: null })];
    expect(
      applyMatchFilters(rows, { ...DEFAULT_MATCH_FILTERS, minAmount: 50000 }, opts).map(
        (r) => r.grants?.title,
      ),
    ).toEqual(["big"]);
  });

  it("separates lead from funded-partner calls", () => {
    const lead = row({ title: "lead", role: "This client can apply as the lead applicant." });
    const partner = row({ title: "partner", role: "Funded partner: an eligible public body…" });
    expect(matchRole(lead)).toBe("lead");
    expect(matchRole(partner)).toBe("funded_partner");
    expect(
      applyMatchFilters([lead, partner], { ...DEFAULT_MATCH_FILTERS, role: "funded_partner" }, opts)
        .length,
    ).toBe(1);
  });

  it("filters to capability fit and home country", () => {
    const rows = [
      row({ title: "fit-home", fit: "pass" }),
      row({ title: "fit-us", fit: "pass", country: "US" }),
      row({ title: "nofit" }),
    ];
    expect(
      applyMatchFilters(
        rows,
        { ...DEFAULT_MATCH_FILTERS, fitOnly: true, homeOnly: true },
        opts,
      ).map((r) => r.grants?.title),
    ).toEqual(["fit-home"]);
  });

  it("sorts by nearest deadline, rolling last", () => {
    const rows = [
      row({ title: "b", deadline: "2027-01-01" }),
      row({ title: "r", deadline: null }),
      row({ title: "a", deadline: "2026-11-01" }),
    ];
    expect(
      applyMatchFilters(rows, { ...DEFAULT_MATCH_FILTERS, sort: "deadline" }, opts).map(
        (r) => r.grants?.title,
      ),
    ).toEqual(["a", "b", "r"]);
  });
});
