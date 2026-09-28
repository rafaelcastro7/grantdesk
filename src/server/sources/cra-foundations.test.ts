import { describe, expect, it } from "vitest";
import { formatProvince, harvestCranRecords, parseGivingAmount } from "./cra-foundations";

describe("parseGivingAmount", () => {
  it("parses numeric and currency strings", () => {
    expect(parseGivingAmount(500_000)).toBe(500_000);
    expect(parseGivingAmount("$1,250,000")).toBe(1_250_000);
    expect(parseGivingAmount("75000.50")).toBe(75_001);
  });

  it("handles null, empty or zero giving", () => {
    expect(parseGivingAmount(null)).toBeNull();
    expect(parseGivingAmount("")).toBeNull();
    expect(parseGivingAmount(0)).toBeNull();
  });
});

describe("formatProvince", () => {
  it("formats 2-letter province to Canadian jurisdiction", () => {
    expect(formatProvince("ON")).toBe("CA-ON");
    expect(formatProvince("QC")).toBe("CA-QC");
  });

  it("defaults to CA when missing", () => {
    expect(formatProvince(null)).toBe("CA");
    expect(formatProvince("")).toBe("CA");
  });
});

describe("harvestCranRecords", () => {
  it("creates funder and philanthropic grant program from valid CRA record", () => {
    const harvest = harvestCranRecords([
      {
        BN: "123456789RR0001",
        "Legal Name": "The Lawson Foundation",
        Designation: "B",
        City: "Toronto",
        Province: "ON",
        "5050": "2500000",
      },
    ]);

    expect(harvest.funders.length).toBe(1);
    expect(harvest.funders[0]?.name).toBe("The Lawson Foundation");
    expect(harvest.funders[0]?.category).toBe("Canadian Private Foundation");
    expect(harvest.funders[0]?.jurisdiction).toBe("CA-ON");

    expect(harvest.grants.length).toBe(1);
    expect(harvest.grants[0]?.title).toBe("The Lawson Foundation — Philanthropic Giving Program");
    expect(harvest.grants[0]?.amountMax).toBe(2_500_000);
    expect(harvest.grants[0]?.country).toBe("CA");
    expect(harvest.grants[0]?.eligibleApplicantTypes).toEqual(["charity", "nonprofit"]);
  });
});
