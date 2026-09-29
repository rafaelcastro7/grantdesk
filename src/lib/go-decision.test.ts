import { describe, expect, it } from "vitest";
import { draftingGate, type DecisionState } from "./go-decision";

const decided = (over: Partial<DecisionState>): DecisionState => ({
  decision: "go",
  decidedBy: "Leadership",
  condition: null,
  conditionMet: false,
  ...over,
});

describe("drafting gate", () => {
  it("blocks writing when no decision exists", () => {
    expect(draftingGate(null).allowed).toBe(false);
  });

  it("blocks writing while the decision is pending", () => {
    expect(draftingGate(decided({ decision: "pending" })).allowed).toBe(false);
  });

  it("blocks a decision with no named approver", () => {
    expect(draftingGate(decided({ decidedBy: "  " })).allowed).toBe(false);
  });

  it("blocks a no-go and says the record is kept", () => {
    const gate = draftingGate(decided({ decision: "no_go" }));
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.reason).toMatch(/kept/);
  });

  it("holds a go-conditional until its condition is met, naming the condition", () => {
    const pending = draftingGate(
      decided({ decision: "go_conditional", condition: "City of Barrie signs on" }),
    );
    expect(pending.allowed).toBe(false);
    if (!pending.allowed) expect(pending.reason).toContain("City of Barrie signs on");

    expect(
      draftingGate(
        decided({ decision: "go_conditional", condition: "City signs", conditionMet: true }),
      ).allowed,
    ).toBe(true);
  });

  it("never blocks a client whose policy has no go / no-go step", () => {
    expect(draftingGate(null, false).allowed).toBe(true);
  });

  it("opens drafting on a named go", () => {
    expect(draftingGate(decided({})).allowed).toBe(true);
  });
});
