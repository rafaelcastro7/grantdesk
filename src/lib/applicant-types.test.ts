import { describe, expect, it } from "vitest";
import {
  fromClientStage,
  fromGrantsGovCodes,
  fromProse,
  listApplicantTypes,
  listPlaces,
  placeName,
} from "./applicant-types";

describe("Grants.gov codes", () => {
  it("maps the 501(c)(3) code to both nonprofit and charity", () => {
    expect(fromGrantsGovCodes(["12"])).toEqual(["charity", "nonprofit"]);
  });

  it("treats 'unrestricted' as open to every type rather than to none", () => {
    // 99 means the funder said anyone may apply. Dropping it would turn an open
    // call into one nobody clears.
    expect(fromGrantsGovCodes(["99"]).length).toBeGreaterThan(5);
  });

  it("yields nothing for the 'see the text field' code", () => {
    // 25 is the funder saying the structured answer is incomplete.
    expect(fromGrantsGovCodes(["25"])).toEqual([]);
  });

  it("ignores codes it does not recognize instead of failing the import", () => {
    expect(fromGrantsGovCodes(["12", "not-a-code"])).toEqual(["charity", "nonprofit"]);
  });
});

describe("prose", () => {
  it("reads a bilingual Canadian eligibility line", () => {
    expect(fromProse("Organismes sans but lucratif et municipalités")).toEqual([
      "government",
      "nonprofit",
    ]);
  });

  it("recognizes Indigenous applicants under several names", () => {
    for (const text of ["First Nations", "Inuit and Métis groups", "Indigenous organizations"]) {
      expect(fromProse(text)).toContain("indigenous");
    }
  });

  it("returns nothing for text that names no applicant type", () => {
    // Silence must stay silence — the rules engine reads this as unknown.
    expect(fromProse("Applications are reviewed quarterly.")).toEqual([]);
    expect(fromProse(null)).toEqual([]);
  });
});

describe("client stage", () => {
  it("expands a charity to also count as a nonprofit", () => {
    expect(fromClientStage("charity")).toEqual(["charity", "nonprofit"]);
  });

  it("falls back to reading an unrecognized stage as prose", () => {
    expect(fromClientStage("community non-profit society")).toContain("nonprofit");
  });

  it("has no opinion when the stage is unset", () => {
    expect(fromClientStage(null)).toEqual([]);
  });
});

describe("labels", () => {
  it("reads as a sentence, not a list of slugs", () => {
    expect(listApplicantTypes(["nonprofit", "academic", "government"])).toBe(
      "nonprofits, universities and colleges and governments and public bodies",
    );
  });
});

describe("place names", () => {
  it("says a subnational code the way a person would", () => {
    // A model handed "CA-ON" wrote that the client operates in the
    // "California-Ontario region". That sentence reaches a funder.
    expect(placeName("CA-ON")).toBe("Ontario, Canada");
    expect(placeName("CA")).toBe("Canada");
    expect(placeName("US")).toBe("the United States");
  });

  it("still resolves the country of a code it does not know", () => {
    // Better than handing over a hyphenated pair to interpret freely.
    expect(placeName("US-CA")).toBe("CA (the United States)");
  });

  it("gives back an unrecognized code rather than inventing a place", () => {
    expect(placeName("ZZ")).toBe("ZZ");
  });

  it("reads as a sentence for several places", () => {
    expect(listPlaces(["CA-ON", "US"])).toBe("Ontario, Canada and the United States");
  });
});
