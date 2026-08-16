import { describe, expect, it } from "vitest";
import { normalizeWordLimit, parseRequirements } from "./extract-requirements";

describe("normalizeWordLimit", () => {
  it("reads the ways a call actually states a limit", () => {
    expect(normalizeWordLimit("500 words")).toBe(500);
    expect(normalizeWordLimit("maximum 1,000 words")).toBe(1000);
    expect(normalizeWordLimit("250-word limit")).toBe(250);
    expect(normalizeWordLimit(750)).toBe(750);
  });

  it("leaves a page count unset rather than converting it by an invented ratio", () => {
    // Pages are not words. Guessing 500-per-page would put a fabricated limit
    // in front of a consultant who would then trust it.
    expect(normalizeWordLimit("max 2 pages")).toBeNull();
    expect(normalizeWordLimit("no limit stated")).toBeNull();
    expect(normalizeWordLimit(null)).toBeNull();
  });
});

describe("parseRequirements", () => {
  const payload = (requirements: unknown[]) => JSON.stringify({ requirements });

  it("keeps the funder's own heading, quote and evaluation note", () => {
    const [requirement] = parseRequirements(
      payload([
        {
          label: "Project Description",
          detail: "Describe the activities and who delivers them.",
          kind: "section",
          wordLimit: "1000 words",
          evaluationNote: "Scored out of 30 for feasibility.",
          sourceQuote: "Applicants must describe the proposed activities.",
          isCritical: true,
        },
      ]),
    );

    expect(requirement).toMatchObject({
      label: "Project Description",
      kind: "section",
      wordLimit: 1000,
      isCritical: true,
      sortOrder: 0,
    });
    expect(requirement!.sourceQuote).toBe("Applicants must describe the proposed activities.");
  });

  it("accepts a model that answers with the wrong shape but the right reading", () => {
    // Phase 1's lesson: rejecting a correct reading because of its shape is a
    // defect in the schema, not in the model.
    const [requirement] = parseRequirements(
      payload([{ label: "Budget", wordLimit: "500 words", kind: "ATTACHMENT" }]),
    );
    expect(requirement).toMatchObject({ label: "Budget", kind: "attachment", wordLimit: 500 });
  });

  it("falls back to 'section' for a kind it does not recognize", () => {
    const [requirement] = parseRequirements(payload([{ label: "Narrative", kind: "essay" }]));
    expect(requirement!.kind).toBe("section");
  });

  it("collapses a heading listed twice into one requirement", () => {
    // Two sections asking the consultant the same question is worse than one.
    const parsed = parseRequirements(
      payload([{ label: "Budget" }, { label: "budget" }, { label: "Timeline" }]),
    );
    expect(parsed.map((r) => r.label)).toEqual(["Budget", "Timeline"]);
    expect(parsed[1]!.sortOrder).toBe(1);
  });

  it("drops entries with no heading rather than inventing one", () => {
    expect(parseRequirements(payload([{ detail: "orphaned" }, { label: "  " }]))).toEqual([]);
  });

  it("returns nothing for a page that is not a call", () => {
    expect(parseRequirements(payload([]))).toEqual([]);
  });

  it("strips the code fence models add despite being told not to", () => {
    const parsed = parseRequirements('```json\n{"requirements":[{"label":"Impact"}]}\n```');
    expect(parsed).toHaveLength(1);
  });

  it("throws on output that is not JSON at all, so the chain hands off", () => {
    expect(() => parseRequirements("I could not read that page.")).toThrow();
  });
});
