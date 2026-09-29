import { describe, expect, it } from "vitest";
import { quoteAppearsIn, verifyQuotes } from "./verify-quote";

const PAGE = `Eligible applicants must be registered  charities or
not-for-profit organizations operating in Ontario. Applications received after
the deadline will not be considered — no exceptions.`;

describe("quote verification", () => {
  it("accepts a quote that is on the page despite spacing, case and punctuation style", () => {
    expect(
      quoteAppearsIn("Eligible applicants must be registered charities or not-for-profit", PAGE),
    ).toBe(true);
    expect(quoteAppearsIn("will not be considered – no exceptions", PAGE)).toBe(true);
  });

  it("rejects a paraphrase presented as verbatim", () => {
    expect(quoteAppearsIn("Only registered charities based in Ontario may apply", PAGE)).toBe(
      false,
    );
  });

  it("checks an elided quote piece by piece, in order", () => {
    expect(quoteAppearsIn("Eligible applicants must be … operating in Ontario", PAGE)).toBe(true);
    expect(quoteAppearsIn("operating in Ontario … Eligible applicants must be", PAGE)).toBe(false);
  });

  it("drops unverified quotes and names the requirement", () => {
    const { items, unverified } = verifyQuotes(
      [
        { label: "Eligibility", sourceQuote: "not-for-profit organizations operating in Ontario" },
        { label: "Invented", sourceQuote: "Applicants must have five years of audited statements" },
      ],
      PAGE,
    );
    expect(items[0]!.sourceQuote).not.toBeNull();
    expect(items[1]!.sourceQuote).toBeNull();
    expect(unverified).toEqual(["Invented"]);
  });
});
