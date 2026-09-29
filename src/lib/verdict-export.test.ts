import { describe, expect, it } from "vitest";
import { groupOf, verdictsCsv, type VerdictExportRow } from "./verdict-export";

const grant = (title: string) => ({
  title,
  country: "CA",
  currency: "CAD",
  amount_min: null,
  amount_max: 50000,
  deadline: "2026-12-01",
  funders: { name: "Funder" },
});

const rows: VerdictExportRow[] = [
  {
    verdict: "ineligible",
    retrieval: null,
    grants: grant("Ruled"),
    eligibility_checks: [{ rule_key: "jurisdiction", status: "fail", detail: "US only" }],
  },
  {
    verdict: "eligible",
    retrieval: { terms: ["youth", "training"] },
    grants: grant("=Verified"),
    eligibility_checks: [
      { rule_key: "jurisdiction", status: "pass", detail: "Canada" },
      { rule_key: "applicant_type", status: "pass", detail: "Nonprofit listed" },
    ],
  },
  {
    verdict: "eligible",
    retrieval: null,
    grants: grant("Unverified"),
    eligibility_checks: [{ rule_key: "applicant_type", status: "unknown", detail: "No list" }],
  },
];

describe("groupOf", () => {
  it("splits eligible on whether the applicant rule passed", () => {
    expect(rows.map(groupOf)).toEqual(["ineligible", "eligible", "unverified"]);
  });
});

describe("verdictsCsv", () => {
  const lines = verdictsCsv(rows).split("\n");

  it("has a status and detail column per rule, in rule order", () => {
    expect(lines[0]).toBe(
      '"Title","Funder","Country","Deadline","Amount min","Amount max","Currency","Group",' +
        '"jurisdiction status","jurisdiction detail","applicant_type status","applicant_type detail",' +
        '"Matched terms"',
    );
  });

  it("orders by group, keeps ruled-out rows, and guards formulas", () => {
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain(`"'=Verified"`);
    expect(lines[1]).toContain('"verified"');
    expect(lines[1]).toContain('"youth; training"');
    expect(lines[2]).toContain('"unverified"');
    expect(lines[2]).toContain('"","","unknown","No list"');
    expect(lines[3]).toContain('"ruled out"');
    expect(lines[3]).toContain('"fail","US only"');
  });
});
