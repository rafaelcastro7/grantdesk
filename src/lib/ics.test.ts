import { describe, expect, it } from "vitest";
import { buildIcs } from "./ics";

describe("deadline calendar", () => {
  const ics = buildIcs(
    [
      {
        uid: "p1",
        title: "Grow grant, OTF",
        client: "Acme; Ltd",
        deadline: "2026-11-04",
        url: "https://www.otf.ca/x",
      },
      { uid: "p2", title: "No date", client: "B", deadline: "rolling" },
    ],
    new Date("2026-09-29T12:00:00Z"),
  );

  it("is a valid calendar with one all-day event per dated deadline", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261104");
    expect(ics).toContain("DTEND;VALUE=DATE:20261105");
  });

  it("escapes separators the format reserves", () => {
    expect(ics).toContain("Grow grant\\, OTF (Acme\\; Ltd)");
  });

  it("reminds a week and a day before", () => {
    expect(ics).toContain("TRIGGER:-P7D");
    expect(ics).toContain("TRIGGER:-P1D");
  });

  it("folds long lines to the spec's limit", () => {
    for (const line of ics.split("\r\n")) expect(line.length).toBeLessThanOrEqual(75);
  });
});
