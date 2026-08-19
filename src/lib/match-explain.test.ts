import { describe, expect, it } from "vitest";
import { explainRelevance, matchedTerms } from "./match-explain";

describe("matchedTerms", () => {
  it("finds the client's own terms in the funder's text", () => {
    expect(
      matchedTerms(["environment", "community"], "Supports community environment projects."),
    ).toEqual(["environment", "community"]);
  });

  it("turns stored slugs back into the words a funder writes", () => {
    expect(matchedTerms(["public-places"], "Improving public places downtown.")).toEqual([
      "public places",
    ]);
  });

  it("counts a plural as the singular a profile stores", () => {
    expect(matchedTerms(["community"], "Grants for communities.")).toEqual(["community"]);
  });

  it("tolerates words between the parts of a phrase", () => {
    // A profile stores a label; a funder writes prose.
    expect(matchedTerms(["public places"], "Improving public green places.")).toEqual([
      "public places",
    ]);
  });

  it("matches on word boundaries, never substrings", () => {
    // The predecessor let "nsf" match "tra-nsf-er", and one visible false
    // claim like that costs the consultant's trust in every other result.
    expect(matchedTerms(["arts"], "Smart systems for logistics.")).toEqual([]);
    expect(matchedTerms(["nsf"], "Electronic funds transfer program.")).toEqual([]);
  });

  it("ignores terms too short to mean anything", () => {
    expect(matchedTerms(["ai", "it"], "Applications for AI and IT.")).toEqual([]);
  });

  it("does not blow up on regex characters in a sector", () => {
    expect(() => matchedTerms(["c++ (advanced)"], "Anything.")).not.toThrow();
  });

  it("returns nothing when there is no text to search", () => {
    expect(matchedTerms(["environment"], null)).toEqual([]);
    expect(matchedTerms(null, "Some text.")).toEqual([]);
  });
});

describe("explainRelevance", () => {
  it("quotes the shared words, so the claim is checkable in a second", () => {
    const relevance = explainRelevance(["environment"], "Community Environment Fund", {
      lexicalRank: 1,
    });
    expect(relevance.statement).toBe(`This funder's own text mentions "environment".`);
  });

  it("says plainly when a match came from meaning rather than words", () => {
    // The most valuable kind of match and the easiest to distrust, so it
    // admits it instead of hiding behind a number.
    const relevance = explainRelevance(["environment"], "Urban Climate Resilience Program", {
      vectorRank: 2,
    });
    expect(relevance.terms).toEqual([]);
    expect(relevance.statement).toMatch(/No shared wording/);
  });

  it("admits it cannot explain a match rather than inventing a reason", () => {
    expect(explainRelevance(["environment"], "Bridge Deck Repair", {}).statement).toBe(
      "We cannot say what made this relevant.",
    );
  });

  it("lists several shared terms as a sentence", () => {
    const relevance = explainRelevance(
      ["environment", "community", "arts"],
      "Community arts in the environment",
      { lexicalRank: 1 },
    );
    expect(relevance.statement).toBe(
      `This funder's own text mentions "environment", "community" and "arts".`,
    );
  });
});
