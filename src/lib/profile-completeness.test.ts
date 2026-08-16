import { describe, expect, it } from "vitest";
import { assessProfile, nextGap, type ProfileFields } from "./profile-completeness";

const full: ProfileFields = {
  sectors: ["technology"],
  jurisdictions: ["CA", "ON"],
  stage: "sme",
  annualBudget: 750_000,
  capabilities: "Three prior applied-research projects with university partners.",
  beneficiaries: "Canadian small businesses",
};

describe("assessProfile", () => {
  it("scores a complete profile at 100 and allows matching", () => {
    const result = assessProfile(full);
    expect(result.score).toBe(100);
    expect(result.missing).toHaveLength(0);
    expect(result.canMatch).toBe(true);
  });

  it("blocks matching when a required field is absent", () => {
    // The whole product promise is that we do not show a client grants they
    // cannot win. Without jurisdictions there is no way to honour that, so
    // matching must not run rather than run badly.
    const result = assessProfile({ ...full, jurisdictions: [] });
    expect(result.canMatch).toBe(false);
    expect(result.missing.map((m) => m.key)).toContain("jurisdictions");
  });

  it("still allows matching when only helpful fields are missing", () => {
    const result = assessProfile({ ...full, capabilities: null, beneficiaries: null });
    expect(result.canMatch).toBe(true);
    expect(result.score).toBe(90);
  });

  it("treats an empty array and whitespace as absent, not present", () => {
    // An extractor that returns [] or "  " must not be able to fake a
    // complete profile — that would silently re-create the incumbent's
    // "profile looks fine, matches are irrelevant" failure.
    const result = assessProfile({ sectors: [], jurisdictions: ["CA"], capabilities: "   " });
    expect(result.missing.map((m) => m.key)).toEqual(
      expect.arrayContaining(["sectors", "capabilities"]),
    );
  });

  it("does not count a zero or negative budget as a real answer", () => {
    expect(assessProfile({ ...full, annualBudget: 0 }).missing.map((m) => m.key)).toContain(
      "annualBudget",
    );
  });

  it("scores an empty profile at zero", () => {
    const result = assessProfile({});
    expect(result.score).toBe(0);
    expect(result.canMatch).toBe(false);
    expect(result.missing).toHaveLength(6);
  });
});

describe("nextGap", () => {
  it("asks for a required field before an important one", () => {
    const result = assessProfile({ capabilities: "x" });
    expect(nextGap(result)?.weight).toBe("required");
  });

  it("falls through to important, then helpful", () => {
    const importantOnly = assessProfile({ ...full, stage: null, capabilities: null });
    expect(nextGap(importantOnly)?.key).toBe("stage");

    const helpfulOnly = assessProfile({ ...full, beneficiaries: null });
    expect(nextGap(helpfulOnly)?.key).toBe("beneficiaries");
  });

  it("returns null when nothing is missing", () => {
    expect(nextGap(assessProfile(full))).toBeNull();
  });

  it("phrases the gap as a consequence, not a field name", () => {
    // Guards the tone: "jurisdictions is required" is useless to a consultant
    // deciding whether it is worth two minutes right now.
    const gap = nextGap(assessProfile({}));
    expect(gap?.prompt).toMatch(/cannot rule out|keyword guess/i);
    expect(gap?.prompt.length).toBeGreaterThan(30);
  });
});
