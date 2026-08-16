import { describe, expect, it } from "vitest";
import { coverageByMarket, isStale, type SourceHealth } from "./coverage";

const NOW = new Date("2026-08-16T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const source = (over: Partial<SourceHealth> = {}): SourceHealth => ({
  key: "grants-gov",
  label: "Grants.gov",
  market: "US",
  cadenceHours: 24,
  lastRunAt: hoursAgo(1),
  grantCount: 100,
  ...over,
});

describe("isStale", () => {
  it("is not stale inside its cadence", () => {
    expect(isStale(source({ lastRunAt: hoursAgo(20) }), NOW)).toBe(false);
  });

  it("tolerates a modest overrun before crying wolf", () => {
    // 24h cadence, 30h old: late, but a single missed run should not flip a
    // whole market to "out of date" in front of the user.
    expect(isStale(source({ lastRunAt: hoursAgo(30) }), NOW)).toBe(false);
  });

  it("is stale once it misses by half again", () => {
    expect(isStale(source({ lastRunAt: hoursAgo(40) }), NOW)).toBe(true);
  });

  it("treats never-run as stale", () => {
    expect(isStale(source({ lastRunAt: null }), NOW)).toBe(true);
  });
});

describe("coverageByMarket", () => {
  it("calls a fresh, populated market automatic", () => {
    const [coverage] = coverageByMarket([source()], NOW);
    expect(coverage?.level).toBe("automatic");
    expect(coverage?.statement).toContain("refreshed automatically");
  });

  it("calls a market with funders but no calls directory-only", () => {
    // This is the case the predecessor got wrong: 83 funders listed that
    // search could never reach, shown exactly like the working ones.
    const [coverage] = coverageByMarket([source({ market: "BR", grantCount: 0 })], NOW);
    expect(coverage?.level).toBe("directory-only");
    expect(coverage?.statement).toContain("no calls are ingested automatically");
  });

  it("downgrades to partial when every populated source is stale, and names it", () => {
    const [coverage] = coverageByMarket([source({ lastRunAt: hoursAgo(100) })], NOW);
    expect(coverage?.level).toBe("partial");
    expect(coverage?.staleSources).toEqual(["Grants.gov"]);
    expect(coverage?.statement).toContain("out of date");
  });

  it("stays automatic while at least one source is fresh", () => {
    const [coverage] = coverageByMarket(
      [
        source({ key: "a", label: "A", lastRunAt: hoursAgo(100) }),
        source({ key: "b", label: "B", lastRunAt: hoursAgo(2) }),
      ],
      NOW,
    );
    expect(coverage?.level).toBe("automatic");
    // Still names the laggard: "automatic" must not hide a broken feed.
    expect(coverage?.staleSources).toEqual(["A"]);
  });

  it("sums grants across a market's sources", () => {
    const [coverage] = coverageByMarket(
      [source({ key: "a", grantCount: 40 }), source({ key: "b", grantCount: 60 })],
      NOW,
    );
    expect(coverage?.grantCount).toBe(100);
  });

  it("reports one row per market, sorted", () => {
    const rows = coverageByMarket(
      [source({ market: "US" }), source({ market: "CA" }), source({ market: "INTL" })],
      NOW,
    );
    expect(rows.map((r) => r.market)).toEqual(["CA", "INTL", "US"]);
  });

  it("returns nothing for no sources rather than inventing a market", () => {
    expect(coverageByMarket([], NOW)).toEqual([]);
  });
});
