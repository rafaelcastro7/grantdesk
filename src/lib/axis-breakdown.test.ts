import { describe, expect, it } from "vitest";
import { axisBreakdown } from "./axis-breakdown";
import type { RuleResult } from "./eligibility";

function rule(over: Partial<RuleResult>): RuleResult {
  return { key: "jurisdiction", status: "pass", isHardGate: true, detail: "ok", ...over };
}

describe("axisBreakdown", () => {
  it("groups checks into eligibility, timeline and budget", () => {
    const axes = axisBreakdown([
      rule({ key: "jurisdiction", status: "pass" }),
      rule({ key: "applicant_type", status: "pass" }),
      rule({ key: "deadline", status: "pass" }),
      rule({ key: "scale", status: "pass" }),
    ]);
    expect(axes.map((a) => a.key)).toEqual(["eligibility", "timeline", "budget"]);
  });

  it("only lists axes that actually have a check", () => {
    const axes = axisBreakdown([rule({ key: "jurisdiction" })]);
    expect(axes.map((a) => a.key)).toEqual(["eligibility"]);
  });

  it("marks an axis failed only when every check in it failed", () => {
    const axes = axisBreakdown([
      rule({ key: "jurisdiction", status: "fail", isHardGate: true }),
      rule({ key: "applicant_type", status: "fail", isHardGate: true }),
    ]);
    expect(axes[0]!.status).toBe("fail");
  });

  it("calls a mixed axis partial rather than picking a side", () => {
    const axes = axisBreakdown([
      rule({ key: "scale", status: "pass" }),
      rule({ key: "cost_share", status: "fail", isHardGate: false }),
    ]);
    expect(axes.find((a) => a.key === "budget")!.status).toBe("partial");
  });

  it("calls an axis unknown when nothing in it could be checked", () => {
    const axes = axisBreakdown([rule({ key: "cost_share", status: "unknown", isHardGate: false })]);
    expect(axes[0]!.status).toBe("unknown");
  });

  // The reason this exists at all: a blended number cannot say *which* half
  // of a verdict is the hard fact and which is the soft guess. Decisive says
  // that plainly instead.
  it("flags an axis as decisive only when a hard gate inside it actually failed", () => {
    const decisive = axisBreakdown([
      rule({ key: "jurisdiction", status: "fail", isHardGate: true }),
    ]);
    expect(decisive[0]!.decisive).toBe(true);

    const notDecisive = axisBreakdown([rule({ key: "scale", status: "fail", isHardGate: false })]);
    expect(notDecisive[0]!.decisive).toBe(false);
  });

  it("carries every check's own detail verbatim, never a rewritten summary", () => {
    const axes = axisBreakdown([
      rule({
        key: "jurisdiction",
        status: "fail",
        detail: "Restricted to US; client operates in CA.",
      }),
    ]);
    expect(axes[0]!.reasons).toEqual(["Restricted to US; client operates in CA."]);
  });

  it("drops a check with no assigned axis instead of throwing", () => {
    expect(() => axisBreakdown([rule({ key: "some_future_rule" })])).not.toThrow();
    expect(axisBreakdown([rule({ key: "some_future_rule" })])).toEqual([]);
  });
});
