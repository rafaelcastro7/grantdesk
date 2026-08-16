import { describe, expect, it } from "vitest";
import { nextPhase, phaseProgress, PHASES, type Phase } from "./phases";

const make = (statuses: Phase["status"][]): Phase[] =>
  statuses.map((status, i) => ({ id: String(i), title: `Phase ${i}`, status }));

describe("phaseProgress", () => {
  it("counts completed phases", () => {
    expect(phaseProgress(make(["done", "done", "pending"]))).toEqual({
      done: 2,
      total: 3,
      complete: false,
    });
  });

  it("reports complete only when every phase is done", () => {
    expect(phaseProgress(make(["done", "done"])).complete).toBe(true);
    expect(phaseProgress(make(["done", "pending"])).complete).toBe(false);
  });

  it("does not call an empty plan complete", () => {
    // Guards the vacuous-truth bug: zero of zero phases is not delivery.
    expect(phaseProgress([]).complete).toBe(false);
  });
});

describe("nextPhase", () => {
  it("returns the first pending phase, in order", () => {
    expect(nextPhase(make(["done", "pending", "pending"]))?.id).toBe("1");
  });

  it("returns null when everything is delivered", () => {
    expect(nextPhase(make(["done"]))).toBeNull();
  });
});

describe("the real plan", () => {
  it("has a unique id per phase", () => {
    const ids = PHASES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is not yet complete", () => {
    // This test is meant to fail on the day the loop's exit condition is met,
    // which is exactly when someone should be forced to re-read it.
    expect(phaseProgress(PHASES).complete).toBe(false);
  });
});
