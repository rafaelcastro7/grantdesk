import { describe, expect, it } from "vitest";
import { cleanDraft, countWords } from "./draft";

describe("cleanDraft", () => {
  it("removes the preamble models add despite being told not to", () => {
    // The preamble ends up in the funder's form otherwise.
    expect(cleanDraft("Here is the section:\n\nOur organization has run…")).toBe(
      "Our organization has run…",
    );
    expect(cleanDraft("Sure! Let me help.\n\nSince 2011 we have…")).toBe("Since 2011 we have…");
  });

  it("removes code fences", () => {
    expect(cleanDraft("```\nOur programs reach 400 students.\n```")).toBe(
      "Our programs reach 400 students.",
    );
  });

  it("leaves prose that starts with a real sentence alone", () => {
    const prose = "Here we serve 400 students a year, across six schools.";
    // "Here we serve…" is the draft, not a preamble — a greedier rule would eat it.
    expect(cleanDraft(prose)).toBe(prose);
  });

  it("keeps the gap markers, which are the point of them", () => {
    const draft = "We served [NEED: number] participants in [NEED: year].";
    expect(cleanDraft(draft)).toBe(draft);
  });
});

describe("countWords", () => {
  it("counts words the way a funder's limit means them", () => {
    expect(countWords("Our organization has served this community since 2011.")).toBe(8);
  });

  it("is zero for nothing, rather than one", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n  ")).toBe(0);
  });
});
