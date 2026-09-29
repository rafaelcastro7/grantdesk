import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { councilDates, parseCouncilDeadlines } from "./canada-council";

// The "Deadlines and notifications" tables from canadacouncil.ca (2026-09-29).
const HTML = readFileSync(
  resolve(process.cwd(), "src/server/sources/__fixtures__/canada-council-deadlines.html"),
  "utf8",
);

describe("Canada Council deadlines", () => {
  const calls = parseCouncilDeadlines(HTML, "2026-09-29");
  const byTitle = (end: string) => calls.find((c) => c.title.endsWith(end));

  it("reads only upcoming deadlines, not past ones awaiting results", () => {
    expect(byTitle(": Artistic Catalysts")).toBeUndefined();
    expect(byTitle(": Artist Driven Organizations")).toBeUndefined();
  });

  it("takes the next future date and drops rows whose dates have all passed", () => {
    expect(byTitle(": Short-Term Projects")).toMatchObject({
      deadline: "2026-11-25",
      status: "open",
      program: expect.stringContaining("Creating, Knowing and Sharing"),
    });
    expect(byTitle(": Circulation and Touring")?.deadline).toBe("2026-10-07");
    expect(byTitle(": Long-Term Projects")).toBeUndefined();
    expect(byTitle(": Literary Publishing Projects")).toBeUndefined();
  });

  it("marks seasonal/TBC rows forecasted and 'any time' rows continuous", () => {
    expect(byTitle(": Literary Publishers")).toMatchObject({
      status: "forecasted",
      deadline: null,
    });
    expect(byTitle(": Artistic Creation")).toMatchObject({ status: "open", deadline: null });
    expect(byTitle(": Artistic Creation")?.url).toMatch(/^https:\/\/cca-internal/);
  });

  it("parses day-month-year dates", () => {
    expect(councilDates("14 January 2026 22 April 2026")).toEqual(["2026-01-14", "2026-04-22"]);
    expect(councilDates("Fall 2027")).toEqual([]);
  });
});
