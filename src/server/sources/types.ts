/**
 * A source is an adapter that declares what it covers and how often, then
 * yields normalized records. Nothing else in the system knows where a grant
 * came from, and nothing else needs to.
 *
 * The declaration is not documentation — coverage.ts derives what we tell the
 * user from `market` and `cadenceHours`, so an adapter that lies about its
 * scope makes the product lie about its scope.
 */

export type SourceFunder = {
  name: string;
  country: string;
  jurisdiction?: string | null;
  category?: string | null;
  website?: string | null;
};

export type SourceGrant = {
  /** Matched to a funder by (name, country). */
  funderName: string;
  funderCountry: string;
  title: string;
  summary?: string | null;
  url: string;
  country: string;
  currency?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
  deadline?: string | null;
  language?: string;
  /**
   * Canonical applicant types (src/lib/applicant-types.ts). An empty array
   * means the source published no machine-readable list — which the rules
   * engine must be able to tell apart from "open to nobody", so adapters never
   * fill this in by inference.
   */
  eligibleApplicantTypes?: readonly string[];
  /** The funder's own eligibility sentence, quoted rather than paraphrased. */
  eligibilityNote?: string | null;
  /**
   * Assistance Listing (formerly CFDA) numbers, for sources that publish them.
   * This is the key USAspending indexes prior awards under, so it is what makes
   * "who won this before" answerable at all.
   */
  assistanceListings?: readonly string[];
  /** Stable across re-runs; this is what makes ingestion idempotent. */
  externalId: string;
};

export type SourceHarvest = {
  funders: SourceFunder[];
  grants: SourceGrant[];
};

export type SourceAdapter = {
  key: string;
  label: string;
  /** ISO country, or INTL for multilateral bodies. */
  market: string;
  /** How often this source is worth re-reading. */
  cadenceHours: number;
  /** One line, shown to a consultant asking where a result came from. */
  description: string;
  harvest: (options: { limit?: number }) => Promise<SourceHarvest>;
};
