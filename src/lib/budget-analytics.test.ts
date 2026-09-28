import { describe, expect, it } from "vitest";
import { calculateBudgetSummary } from "./budget-analytics";

describe("budget-analytics", () => {
  it("computes totals, variance and cap compliance", () => {
    const summary = calculateBudgetSummary(
      [
        {
          id: "1",
          category: "Personnel",
          description: "Researcher",
          plannedAmount: 50000,
          actualAmount: 48000,
        },
        {
          id: "2",
          category: "Equipment",
          description: "Hardware",
          plannedAmount: 10000,
          actualAmount: 11000,
        },
      ],
      70000,
    );

    expect(summary.totalPlanned).toBe(60000);
    expect(summary.totalActual).toBe(59000);
    expect(summary.netVariance).toBe(1000);
    expect(summary.withinCap).toBe(true);
    expect(summary.categoryTotals.Personnel).toBe(50000);
    expect(summary.categoryTotals.Equipment).toBe(10000);
  });

  it("flags when total planned exceeds grant maximum cap", () => {
    const summary = calculateBudgetSummary(
      [{ id: "1", category: "Personnel", description: "Lead", plannedAmount: 120000 }],
      100000,
    );
    expect(summary.withinCap).toBe(false);
  });
});
