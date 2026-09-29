import { describe, expect, it } from "vitest";
import { daysUntilDeadline, deadlineEnd } from "./deadline";

describe("deadline end", () => {
  it("ends at 23:59:59 Toronto time, not UTC", () => {
    // EDT is UTC-4, so the last second of 2026-10-05 is 03:59:59Z on the 6th.
    expect(new Date(deadlineEnd("2026-10-05")).toISOString()).toBe("2026-10-06T03:59:59.000Z");
    // EST in winter is UTC-5.
    expect(new Date(deadlineEnd("2026-12-01")).toISOString()).toBe("2026-12-02T04:59:59.000Z");
  });

  it("keeps a call open on its last evening in Eastern time", () => {
    // 21:00 EDT on the deadline day is 01:00Z the next day.
    expect(daysUntilDeadline("2026-10-05", new Date("2026-10-06T01:00:00Z"))).toBe(1);
    expect(daysUntilDeadline("2026-10-05", new Date("2026-10-06T05:00:00Z"))).toBeLessThan(0);
  });

  it("reports an unreadable date as NaN rather than guessing", () => {
    expect(Number.isNaN(deadlineEnd("Oct 5"))).toBe(true);
  });
});
