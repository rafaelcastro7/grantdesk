import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { esdcApplicantTypes, esdcDeadline, parseCanadaCaSections, parseEsdcFunding } from "./esdc";

// Trimmed from ESDC's own funding-en-new.json (2026-09-29): every entry marked
// open that day, plus two that were not.
const FIXTURE = JSON.parse(
  readFileSync(resolve(process.cwd(), "src/server/sources/__fixtures__/esdc-funding.json"), "utf8"),
);

describe("ESDC funding JSON", () => {
  const calls = parseEsdcFunding(FIXTURE);

  it("keeps only entries the department marks open, dropping invitation-only ones", () => {
    expect(calls.map((c) => c.title)).not.toContain("Canada Summer Jobs");
    expect(calls.some((c) => c.title.startsWith("Indigenous Early Learning"))).toBe(false);
    expect(calls.length).toBe(7);
  });

  it("reads the closing date, amount and applicants of a dated call", () => {
    const sdpp = calls.find((c) => c.title.startsWith("Social Development Partnership"))!;
    expect(sdpp.deadline).toBe("2026-10-08");
    expect(sdpp.amountMax).toBe(1000000);
    expect(sdpp.applicantTypes).toEqual(["charity", "nonprofit"]);
    expect(sdpp.url).toMatch(/^https:\/\/www\.canada\.ca\//);
  });

  it("leaves applicant types unknown when any tag is unmapped", () => {
    const training = calls.find((c) => c.title === "Investments in Training Equipment")!;
    expect(training.applicantTypes).toEqual([]);
    expect(training.applicantsText).toContain("Unions");
    expect(training.deadline).toBeNull();
  });
});

describe("ESDC helpers", () => {
  it("strips ordinals before reading the date", () => {
    expect(esdcDeadline("until October 23rd, 2026 at 11:59 pm Pacific Time (PT) ")).toBe(
      "2026-10-23",
    );
    expect(esdcDeadline("")).toBeNull();
  });

  it("maps a fully known tag list", () => {
    expect(esdcApplicantTypes([{ Tag: "apply-notprofit" }, { Tag: "apply-indigenous" }])).toEqual([
      "charity",
      "indigenous",
      "nonprofit",
    ]);
  });

  it("reads eligibility and contact sections from a canada.ca page", () => {
    const page = parseCanadaCaSections(
      `<main><h2>Description</h2><p>x</p><h2>Who can apply</h2><p>Not-for-profit organizations.</p><h2>Contact us</h2><p>Email us.</p></main>`,
    );
    expect(page.eligibility).toContain("Not-for-profit");
    expect(page.contact).toContain("Email us");
  });
});
