import { describe, expect, it } from "vitest";
import { calculateGrantRoi, prioritizeGrants } from "./prioritization";

describe("prioritization logic", () => {
  it("calculates expected return and ROI score accurately", () => {
    const res = calculateGrantRoi({
      id: "1",
      title: "Tech Innovation Grant",
      funderName: "Innovation Canada",
      amountMax: 100000,
      relevance: 0.9,
      requirementCount: 2,
      deadline: "2026-12-31",
    });

    expect(res.expectedValue).toBe(90000); // 100000 * 0.9
    expect(res.estimatedHours).toBe(12); // 2 * 6 = 12
    expect(res.roiScore).toBe(7500); // 90000 / 12
    expect(res.quadrant).toBe("quick_wins"); // ROI > 2000 & hours <= 20
  });

  it("classifies high value bets when hours required are high", () => {
    const res = calculateGrantRoi({
      id: "2",
      title: "Large Scale Infrastructure",
      funderName: "Infrastructure Canada",
      amountMax: 500000,
      relevance: 0.8,
      requirementCount: 5,
      deadline: "2026-11-30",
    });

    expect(res.estimatedHours).toBe(30); // 5 * 6 = 30
    expect(res.quadrant).toBe("high_value"); // ROI > 2000 & hours > 20
  });

  it("sorts list by ROI score descending", () => {
    const list = prioritizeGrants([
      {
        id: "a",
        title: "Low ROI",
        funderName: "F1",
        amountMax: 10000,
        relevance: 0.2,
        requirementCount: 5,
        deadline: null,
      },
      {
        id: "b",
        title: "High ROI",
        funderName: "F2",
        amountMax: 200000,
        relevance: 0.9,
        requirementCount: 2,
        deadline: null,
      },
    ]);

    expect(list[0]!.id).toBe("b");
    expect(list[1]!.id).toBe("a");
  });
});
