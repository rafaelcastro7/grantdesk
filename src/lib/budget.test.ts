import { describe, expect, it } from "vitest";
import { checkBudget, computeBudget, lineCost, type BudgetLine } from "./budget";

const line = (over: Partial<BudgetLine>): BudgetLine => ({
  category: "Staff",
  hours: null,
  rate: null,
  amount: null,
  funded_by: "grant",
  ...over,
});

const rules = {
  currency: "CAD",
  amountMin: null,
  amountMax: null,
  costSharePercent: null,
  inKindCapPercent: null,
};

describe("computeBudget", () => {
  it("multiplies hours by rate and prefers a flat amount", () => {
    expect(lineCost(line({ hours: 10, rate: 85 }))).toBe(850);
    expect(lineCost(line({ hours: 10, rate: 85, amount: 1000 }))).toBe(1000);
  });

  it("splits request, cash match and in-kind, with shares", () => {
    const t = computeBudget([
      line({ amount: 75_000 }),
      line({ amount: 15_000, funded_by: "cash_match" }),
      line({ hours: 100, rate: 100, funded_by: "in_kind" }),
    ]);
    expect(t).toMatchObject({
      request: 75_000,
      cashMatch: 15_000,
      inKind: 10_000,
      match: 25_000,
      totalCost: 100_000,
      matchPercent: 25,
      inKindShareOfMatch: 40,
    });
  });

  it("has no shares for an empty budget rather than dividing by zero", () => {
    const t = computeBudget([]);
    expect(t.matchPercent).toBeNull();
    expect(t.inKindShareOfMatch).toBeNull();
  });
});

describe("checkBudget", () => {
  const budget = computeBudget([
    line({ amount: 80_000 }),
    line({ amount: 5_000, funded_by: "cash_match" }),
    line({ amount: 15_000, funded_by: "in_kind" }),
  ]);

  it("flags a request above the award range, in the call's currency", () => {
    const found = checkBudget(budget, { ...rules, amountMax: 50_000 });
    expect(found.find((f) => f.level === "violation")?.text).toMatch(/above the most.*CAD/);
  });

  it("flags a match below the required cost share", () => {
    const found = checkBudget(budget, { ...rules, amountMax: 100_000, costSharePercent: 25 });
    expect(found.some((f) => f.level === "violation" && /25%.*20%/.test(f.text))).toBe(true);
  });

  it("flags in-kind above the cap", () => {
    const found = checkBudget(budget, {
      ...rules,
      amountMax: 100_000,
      costSharePercent: 20,
      inKindCapPercent: 50,
    });
    const violations = found.filter((f) => f.level === "violation");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.text).toMatch(/75%.*caps it at 50%/);
  });

  it("reports unpublished rules as unchecked, never as met", () => {
    const found = checkBudget(budget, rules);
    expect(found.every((f) => f.level === "unknown")).toBe(true);
    expect(found).toHaveLength(3);
  });
});
