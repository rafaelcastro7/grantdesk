import { describe, expect, it } from "vitest";
import { hasQueryableProfile, lexicalQuery, semanticQuery } from "./match-query";

describe("lexicalQuery", () => {
  it("joins sectors disjunctively, because space means AND in websearch_to_tsquery", () => {
    // The obvious "education environment" would demand both words in one grant.
    expect(lexicalQuery({ sectors: ["education", "environment"] })).toBe(
      "education or environment",
    );
  });

  it("turns stored slugs back into the words a funder would actually write", () => {
    expect(lexicalQuery({ sectors: ["public-places"] })).toBe('"public places"');
  });

  it("drops duplicates that survive humanizing", () => {
    expect(lexicalQuery({ sectors: ["health_wellbeing", "health-wellbeing"] })).toBe(
      '"health wellbeing"',
    );
  });

  it("is empty for a profile with no sectors, rather than matching everything", () => {
    expect(lexicalQuery({ sectors: [] })).toBe("");
  });
});

describe("semanticQuery", () => {
  it("reads as prose, not as a field dump", () => {
    const text = semanticQuery({
      sectors: ["arts", "community"],
      stage: "nonprofit",
      jurisdictions: ["CA-ON"],
      beneficiaries: "newcomers in Toronto",
    });

    expect(text).toContain("An organization working in arts, community.");
    expect(text).toContain("It is a nonprofit.");
    expect(text).toContain("It serves newcomers in Toronto");
    expect(text).not.toContain("undefined");
  });

  it("omits sentences it has no facts for instead of writing empty ones", () => {
    expect(semanticQuery({ sectors: ["arts"] })).toBe("An organization working in arts.");
  });
});

describe("hasQueryableProfile", () => {
  it("refuses a profile that would retrieve on nothing", () => {
    expect(hasQueryableProfile({})).toBe(false);
    expect(hasQueryableProfile({ sectors: [] })).toBe(false);
  });

  it("accepts a profile carrying only prose", () => {
    expect(hasQueryableProfile({ capabilities: "We run after-school programs." })).toBe(true);
  });
});
