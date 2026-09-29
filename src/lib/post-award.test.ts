import { describe, expect, it } from "vitest";
import { inRenewalWindow, isReminderDay } from "./post-award";

const now = new Date("2026-09-29T15:00:00Z");

describe("inRenewalWindow", () => {
  it("opens within 120 days of the agreement end", () => {
    expect(inRenewalWindow("2026-12-31", now)).toBe(true);
    expect(inRenewalWindow("2027-06-30", now)).toBe(false);
  });

  it("is closed once the agreement has ended, and without an end date", () => {
    expect(inRenewalWindow("2026-09-01", now)).toBe(false);
    expect(inRenewalWindow(null, now)).toBe(false);
  });
});

describe("isReminderDay", () => {
  it("fires at 14, 7, 3 and 1 days only", () => {
    expect(isReminderDay("2026-10-12", now)).toBe(14);
    expect(isReminderDay("2026-10-05", now)).toBe(7);
    expect(isReminderDay("2026-10-06", now)).toBeNull();
  });
});
