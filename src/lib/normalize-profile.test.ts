import { describe, expect, it } from "vitest";
import {
  normalizeBudget,
  normalizeJurisdictions,
  normalizeProse,
  normalizeSectors,
  normalizeStage,
} from "./normalize-profile";

describe("normalizeJurisdictions", () => {
  it("maps the country names models actually return", () => {
    // Observed live from cerebras/gemma-4-31b: ["Canada","North America"].
    expect(normalizeJurisdictions(["Canada", "North America"])).toEqual(["CA"]);
  });

  it("keeps codes that are already canonical", () => {
    expect(normalizeJurisdictions(["CA", "ON", "US-CA"])).toEqual(["CA", "ON", "US-CA"]);
  });

  it("expands a province to imply its country", () => {
    // A client in Ontario is eligible for federal programs too; dropping the
    // country would hide every CA-Federal grant from them.
    expect(normalizeJurisdictions(["Ontario"])).toEqual(["CA", "ON"]);
  });

  it("drops continent-scale answers as useless", () => {
    // True but unusable: it would make every grant on the continent a match,
    // which is the exact false-positive failure this product exists to fix.
    expect(normalizeJurisdictions(["Global", "the Americas", "worldwide"])).toEqual([]);
  });

  it("deduplicates", () => {
    expect(normalizeJurisdictions(["Canada", "CA", "Ontario", "ON"])).toEqual(["CA", "ON"]);
  });

  it("survives junk input", () => {
    expect(normalizeJurisdictions(null)).toEqual([]);
    expect(normalizeJurisdictions([42, "", "   "])).toEqual([]);
    expect(normalizeJurisdictions("Canada")).toEqual(["CA"]);
  });

  it("handles accented spellings", () => {
    expect(normalizeJurisdictions(["Québec", "México"])).toEqual(["CA", "QC", "MX"]);
  });
});

describe("normalizeStage", () => {
  it("accepts the canonical values unchanged", () => {
    expect(normalizeStage("sme")).toBe("sme");
  });

  it("maps the free text models return", () => {
    // Observed live: "seed-stage".
    expect(normalizeStage("seed-stage")).toBe("startup");
    expect(normalizeStage("Registered charity")).toBe("nonprofit");
    expect(normalizeStage("University research institute")).toBe("research");
    expect(normalizeStage("Municipal government agency")).toBe("public");
    expect(normalizeStage("small and medium enterprise")).toBe("sme");
  });

  it("falls back to unknown rather than guessing", () => {
    expect(normalizeStage("purple")).toBe("unknown");
    expect(normalizeStage(null)).toBe("unknown");
  });
});

describe("normalizeProse", () => {
  it("joins the arrays models return into prose", () => {
    // Observed live: capabilities came back as a list, not a sentence.
    expect(normalizeProse(["innovation hub", "venture capital"])).toBe(
      "innovation hub; venture capital",
    );
  });

  it("passes prose through, collapsed", () => {
    expect(normalizeProse("  We build\n  software  ")).toBe("We build software");
  });

  it("returns null for nothing usable", () => {
    expect(normalizeProse([])).toBeNull();
    expect(normalizeProse("   ")).toBeNull();
    expect(normalizeProse(undefined)).toBeNull();
  });

  it("truncates to the cap", () => {
    expect(normalizeProse("x".repeat(50), 10)).toHaveLength(10);
  });
});

describe("normalizeSectors", () => {
  it("slugifies and deduplicates", () => {
    expect(normalizeSectors(["Clean Tech", "clean-tech", "Health Care"])).toEqual([
      "clean-tech",
      "health-care",
    ]);
  });

  it("splits a comma-separated string", () => {
    expect(normalizeSectors("technology, education")).toEqual(["technology", "education"]);
  });

  it("caps the list so one page cannot flood the profile", () => {
    expect(normalizeSectors(Array.from({ length: 30 }, (_, i) => `sector${i}`))).toHaveLength(8);
  });
});

describe("normalizeBudget", () => {
  it("accepts numbers", () => {
    expect(normalizeBudget(750_000)).toBe(750_000);
  });

  it("parses the formats humans write", () => {
    expect(normalizeBudget("$750,000")).toBe(750_000);
    expect(normalizeBudget("750K")).toBe(750_000);
    expect(normalizeBudget("2.5 million")).toBe(2_500_000);
  });

  it("rejects zero, negatives and nonsense", () => {
    expect(normalizeBudget(0)).toBeNull();
    expect(normalizeBudget(-5)).toBeNull();
    expect(normalizeBudget("not disclosed")).toBeNull();
    expect(normalizeBudget(null)).toBeNull();
  });
});
