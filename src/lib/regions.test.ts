import { describe, expect, it } from "vitest";
import { bandOf, countryOf, homeCountries, isInAmericas, retrievalBands } from "./regions";

describe("reading a place", () => {
  it("collapses a province onto its country", () => {
    expect(countryOf("CA-ON")).toBe("CA");
    expect(countryOf(" ca ")).toBe("CA");
  });

  it("has no opinion about an empty one", () => {
    expect(countryOf(null)).toBeNull();
    expect(countryOf("")).toBeNull();
  });

  it("counts multilateral funders as part of the continent", () => {
    // A call from the Inter-American Development Bank is not foreign to anyone
    // here, and treating it as outside the region would hide the one kind of
    // cross-border money most of these clients can actually reach.
    expect(isInAmericas("INTL")).toBe(true);
    expect(isInAmericas("MX")).toBe(true);
    expect(isInAmericas("DE")).toBe(false);
  });

  it("reads a client's country once, however many provinces it lists", () => {
    expect(homeCountries(["CA-ON", "CA-QC", "CA"])).toEqual(["CA"]);
  });
});

describe("splitting the search", () => {
  it("gives home two thirds and the continent the rest", () => {
    const bands = retrievalBands(["CA-ON"], 60);

    expect(bands.map((b) => b.key)).toEqual(["home", "americas"]);
    expect(bands[0]!.countries).toEqual(["CA"]);
    expect(bands[0]!.budget).toBe(40);
    expect(bands[1]!.budget).toBe(20);
    // The whole budget is spent, or the consultant silently gets fewer results
    // than the run claims to have looked at.
    expect(bands[0]!.budget + bands[1]!.budget).toBe(60);
  });

  it("never searches the home country twice", () => {
    const bands = retrievalBands(["CA"], 60);
    expect(bands[1]!.countries).not.toContain("CA");
    expect(bands[1]!.countries).toContain("US");
    expect(bands[1]!.countries).toContain("INTL");
  });

  it("keeps a reserved place for home even at a tiny budget", () => {
    // Rounding a small budget to zero would reintroduce exactly the failure
    // this split exists to prevent, only harder to notice.
    const bands = retrievalBands(["CA"], 1);
    expect(bands[0]!.budget).toBeGreaterThanOrEqual(1);
  });

  it("does not invent a home country for a client without one", () => {
    const bands = retrievalBands([], 60);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.key).toBe("americas");
    expect(bands[0]!.budget).toBe(60);
  });

  it("treats a client outside the Americas as having no home band here", () => {
    // The catalog covers this continent. Reserving two thirds of a German
    // client's search for Germany would reserve it for nothing.
    const bands = retrievalBands(["DE"], 60);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.key).toBe("americas");
  });
});

describe("labelling a result", () => {
  it("puts a call from the client's own country at home", () => {
    expect(bandOf("CA", ["CA-ON"])).toBe("home");
  });

  it("puts everything else on the continent", () => {
    expect(bandOf("US", ["CA-ON"])).toBe("americas");
    expect(bandOf("INTL", ["CA-ON"])).toBe("americas");
  });

  it("does not claim a call is at home when we do not know where home is", () => {
    expect(bandOf("CA", [])).toBe("americas");
  });
});
