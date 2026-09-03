import { describe, expect, it } from "vitest";
import {
  critiqueExtraction,
  type ExtractedRequirement,
  type Page,
} from "../../src/server/extract-requirements";

/**
 * The generator/critic pattern this whole feature is built on: a second,
 * independent model call reads the same pages against the same extracted
 * list, with no memory of having produced it, specifically to find what
 * agreeing with yourself cannot. Proved here against controlled fixtures
 * rather than a live page, since the point is the critic's judgment, not
 * any particular funder's content.
 */

const PAGE: Page = {
  url: "https://example.gov/regional-innovation-fund",
  title: "Regional Innovation Fund",
  text: [
    "The Regional Innovation Fund supports nonprofit organizations developing",
    "applied research partnerships. Applicants must submit a completed",
    "Application for Financial Assistance and a signed letter of support from",
    "a partner organization. Projects must be completed within 18 months of",
    "the award date. To apply, contact your regional office to discuss your",
    "project before submitting the application form.",
  ].join(" "),
};

function requirement(over: Partial<ExtractedRequirement>): ExtractedRequirement {
  return {
    label: "Application for Financial Assistance",
    detail: null,
    kind: "attachment",
    wordLimit: null,
    evaluationNote: null,
    sourceQuote: null,
    isCritical: true,
    sortOrder: 0,
    ...over,
  };
}

describe("critiqueExtraction", () => {
  it("says complete when the list genuinely covers the pages", async () => {
    // Genuinely covering the fixture page means all four things it states:
    // the form, the letter, the completion window, and how to apply. The
    // first version of this test listed only three and left out the
    // 18-month completion condition — the critic correctly called that
    // incomplete, which is the behavior this whole feature exists for, not
    // a bug in the assertion it was breaking.
    const result = await critiqueExtraction(
      [PAGE],
      [
        requirement({ label: "Application for Financial Assistance", kind: "attachment" }),
        requirement({ label: "Letter of Support", kind: "attachment" }),
        requirement({
          label: "Project completion window",
          kind: "eligibility",
          sourceQuote: "Projects must be completed within 18 months of the award date.",
        }),
        requirement({
          label: "How to apply",
          kind: "process",
          sourceQuote: "contact your regional office",
        }),
      ],
    );
    expect(result.complete).toBe(true);
  }, 30_000);

  it("names a real requirement the pages state that the list left out", async () => {
    // The letter of support and the 18-month completion condition are both
    // stated on the page; only the application form was extracted.
    const result = await critiqueExtraction(
      [PAGE],
      [requirement({ label: "Application for Financial Assistance", kind: "attachment" })],
    );
    expect(result.complete).toBe(false);
    expect(result.concerns.length).toBeGreaterThan(0);
    const joined = result.concerns.join(" ").toLowerCase();
    expect(joined).toMatch(/letter of support|18 months|how to apply|regional office/);
  }, 30_000);
});
