import { describe, expect, it } from "vitest";
import { minutesUntilNextDue, sourcesDue, type SourceSchedule } from "./refresh-schedule";

const NOW = new Date("2026-08-19T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const daily: SourceSchedule = { key: "grants-gov", cadenceHours: 24, lastOkAt: hoursAgo(1) };
const weekly: SourceSchedule = {
  key: "business-benefits-finder",
  cadenceHours: 24 * 7,
  lastOkAt: hoursAgo(1),
};

describe("sourcesDue", () => {
  it("reads a source that has never been read", () => {
    const due = sourcesDue([{ ...daily, lastOkAt: null }], NOW);
    expect(due).toEqual([{ key: "grants-gov", reason: "never read" }]);
  });

  it("leaves a source alone inside its cadence", () => {
    expect(sourcesDue([daily, weekly], NOW)).toEqual([]);
  });

  it("reads a source once a full cadence has passed", () => {
    const due = sourcesDue([{ ...daily, lastOkAt: hoursAgo(25) }, weekly], NOW);
    expect(due.map((d) => d.key)).toEqual(["grants-gov"]);
    expect(due[0]!.reason).toContain("cadence 24h");
  });

  it("respects each source's own cadence rather than one global interval", () => {
    // The weekly source is 100 hours stale and still not due; the daily one is
    // due at 24. A single interval would either hammer the weekly source or
    // starve the daily one.
    const due = sourcesDue(
      [
        { ...daily, lastOkAt: hoursAgo(30) },
        { ...weekly, lastOkAt: hoursAgo(100) },
      ],
      NOW,
    );
    expect(due.map((d) => d.key)).toEqual(["grants-gov"]);
  });

  it("measures from the last success, not the last attempt", () => {
    // A source failing every hour has not been read. Counting its failures as
    // reads would let a broken source look like a fresh one — the exact
    // dishonesty the coverage page exists to prevent. `lastOkAt` is the only
    // input, so this is structural rather than a rule that can be forgotten.
    const failingForDays = sourcesDue([{ ...daily, lastOkAt: hoursAgo(72) }], NOW);
    expect(failingForDays).toHaveLength(1);
  });
});

describe("minutesUntilNextDue", () => {
  it("reports when the soonest source comes up", () => {
    // 23 hours since a 24-hour cadence: one hour to go.
    expect(minutesUntilNextDue([{ ...daily, lastOkAt: hoursAgo(23) }], NOW)).toBe(60);
  });

  it("picks the soonest of several", () => {
    expect(
      minutesUntilNextDue(
        [
          { ...daily, lastOkAt: hoursAgo(23) },
          { ...weekly, lastOkAt: hoursAgo(167) },
        ],
        NOW,
      ),
    ).toBe(60);
  });

  it("has no answer when everything is already due", () => {
    expect(minutesUntilNextDue([{ ...daily, lastOkAt: hoursAgo(50) }], NOW)).toBeNull();
  });
});
