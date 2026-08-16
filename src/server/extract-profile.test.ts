import { describe, expect, it } from "vitest";
import { parseExtraction } from "./extract-profile";

// The network call belongs in an eval (tests/evals), not a unit test: a model's
// answer is a distribution, not a fixed value. What IS decidable — and what
// actually broke against live providers — is the parse-and-normalize boundary.

describe("parseExtraction", () => {
  it("parses the shape a model really returned", () => {
    // Verbatim from cerebras/gemma-4-31b on marsdd.com: country names rather
    // than codes, a stage outside the enum, and lists where prose was asked
    // for. The first schema rejected all of it and every provider "failed"
    // on a perfectly good reading of the page.
    const observed = JSON.stringify({
      sectors: ["technology", "science", "environment", "health", "economy"],
      jurisdictions: ["Canada", "North America"],
      stage: "seed-stage",
      annualBudget: null,
      currency: null,
      capabilities: ["innovation hub", "venture capital", "real estate"],
      beneficiaries: ["startups", "entrepreneurs"],
      confidence: 0.9,
    });

    const parsed = parseExtraction(observed);

    expect(parsed.jurisdictions).toEqual(["CA"]);
    expect(parsed.stage).toBe("startup");
    expect(parsed.capabilities).toBe("innovation hub; venture capital; real estate");
    expect(parsed.beneficiaries).toBe("startups; entrepreneurs");
    expect(parsed.sectors).toContain("technology");
  });

  it("tolerates the markdown fence models add despite instructions", () => {
    const fenced = '```json\n{"jurisdictions":["Ontario"],"sectors":["clean tech"]}\n```';
    const parsed = parseExtraction(fenced);
    expect(parsed.jurisdictions).toEqual(["CA", "ON"]);
    expect(parsed.sectors).toEqual(["clean-tech"]);
  });

  it("treats a silent page as empty rather than guessing", () => {
    // "The page did not say" must survive as an empty field so that
    // profile-completeness asks the consultant for it. Inventing a plausible
    // value here would produce confident, wrong matches.
    const parsed = parseExtraction("{}");
    expect(parsed.sectors).toEqual([]);
    expect(parsed.jurisdictions).toEqual([]);
    expect(parsed.stage).toBe("unknown");
    expect(parsed.annualBudget).toBeNull();
    expect(parsed.capabilities).toBeNull();
  });

  it("rejects output that is not JSON at all, so the chain moves on", () => {
    expect(() => parseExtraction("I'd be happy to help! Here is the profile:")).toThrow();
  });

  it("normalizes a budget written as text", () => {
    expect(parseExtraction('{"annualBudget":"$2.5 million"}').annualBudget).toBe(2_500_000);
  });

  it("clamps confidence into range", () => {
    expect(() => parseExtraction('{"confidence":5}')).toThrow();
  });
});
