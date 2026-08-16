/**
 * What we can honestly claim about each market.
 *
 * The predecessor listed 699 funders while search could reach only 5 of them,
 * and its documentation advertised capabilities the code did not have. This
 * module exists so that never happens twice: coverage is derived from what the
 * sources actually deliver, and the UI renders that derivation rather than a
 * marketing sentence.
 *
 * The three levels are deliberately blunt, because a consultant deciding where
 * to spend an hour needs a verdict, not a percentage.
 */

export type CoverageLevel = "automatic" | "partial" | "directory-only";

export type SourceHealth = {
  /** Stable key, also stored on every row the source produced. */
  key: string;
  label: string;
  /** ISO country, or "INTL" for multilateral bodies. */
  market: string;
  /** How often the source is expected to refresh, in hours. */
  cadenceHours: number;
  /** When it last completed, or null if it never has. */
  lastRunAt: Date | null;
  /** Rows currently in the catalog from this source. */
  grantCount: number;
};

export type MarketCoverage = {
  market: string;
  level: CoverageLevel;
  grantCount: number;
  /** Sources whose last run is older than their cadence allows. */
  staleSources: string[];
  /** One sentence a consultant can act on. */
  statement: string;
};

/** A source is stale once it has missed its cadence by more than half again. */
export const STALENESS_FACTOR = 1.5;

export function isStale(source: SourceHealth, now: Date): boolean {
  if (!source.lastRunAt) return true;
  const ageHours = (now.getTime() - source.lastRunAt.getTime()) / 3_600_000;
  return ageHours > source.cadenceHours * STALENESS_FACTOR;
}

function levelFor(sources: SourceHealth[], now: Date): CoverageLevel {
  const withGrants = sources.filter((s) => s.grantCount > 0);
  if (withGrants.length === 0) return "directory-only";
  const fresh = withGrants.filter((s) => !isStale(s, now));
  if (fresh.length === 0) return "partial";
  return "automatic";
}

function statementFor(
  market: string,
  level: CoverageLevel,
  grantCount: number,
  staleSources: string[],
): string {
  switch (level) {
    case "automatic":
      return `${grantCount.toLocaleString()} open calls, refreshed automatically.`;
    case "partial":
      return staleSources.length
        ? `${grantCount.toLocaleString()} calls, but ${staleSources.join(" and ")} has not refreshed on schedule — treat this market as out of date.`
        : `${grantCount.toLocaleString()} calls, refreshing irregularly.`;
    case "directory-only":
      return `Funders are listed for ${market}, but no calls are ingested automatically — check their pages directly.`;
  }
}

export function coverageByMarket(
  sources: SourceHealth[],
  now: Date = new Date(),
): MarketCoverage[] {
  const markets = [...new Set(sources.map((s) => s.market))].sort();

  return markets.map((market) => {
    const forMarket = sources.filter((s) => s.market === market);
    const grantCount = forMarket.reduce((total, s) => total + s.grantCount, 0);
    const level = levelFor(forMarket, now);
    const staleSources = forMarket
      .filter((s) => s.grantCount > 0 && isStale(s, now))
      .map((s) => s.label);

    return {
      market,
      level,
      grantCount,
      staleSources,
      statement: statementFor(market, level, grantCount, staleSources),
    };
  });
}
