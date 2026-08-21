/**
 * Where a call is from, and how much of the search belongs to each place.
 *
 * This exists because of a measurement. Retrieval ranked purely by relevance
 * and returned the top sixty; for a Canadian client that meant ten Canadian
 * calls out of 1,321 open ones. The other 1,311 were not ruled out — they were
 * never looked at, because Canada is 44% of the catalog and 30% of the ranking
 * at every depth, and sixty rows arrive with that proportion baked in.
 *
 * A country filter would have fixed it by throwing the continent away. A
 * relevance boost would have fixed it invisibly, by an amount nobody could
 * state. So the search is split into bands with a stated size instead: most of
 * it at home, the rest across the Americas. Each band is ranked on its own
 * merits, and the consultant can be told exactly what was searched where.
 */

/**
 * The Americas, plus the multilateral bodies that fund across them.
 *
 * INTL is here because a call from the Inter-American Development Bank is not
 * "foreign" to anyone on this continent — it is the one kind of funder whose
 * jurisdiction is the whole region.
 */
export const AMERICAS = [
  "AR",
  "BO",
  "BR",
  "BZ",
  "CA",
  "CL",
  "CO",
  "CR",
  "CU",
  "DO",
  "EC",
  "GT",
  "GY",
  "HN",
  "HT",
  "JM",
  "MX",
  "NI",
  "PA",
  "PE",
  "PR",
  "PY",
  "SR",
  "SV",
  "TT",
  "US",
  "UY",
  "VE",
  "INTL",
] as const;

const AMERICAS_SET = new Set<string>(AMERICAS);

/** Normalize "ca-on", " CA " and "CA" to the same thing. */
export function countryOf(place: string | null | undefined): string | null {
  const trimmed = place?.trim().toUpperCase();
  if (!trimmed) return null;
  const country = trimmed.split("-")[0];
  return country && country.length >= 2 ? country : null;
}

export function isInAmericas(country: string | null | undefined): boolean {
  const code = countryOf(country);
  return code !== null && AMERICAS_SET.has(code);
}

export type Band = {
  /** Stable key, used for grouping on the screen and in tests. */
  key: "home" | "americas";
  /** Countries this band searches, or null for "anywhere". */
  countries: string[] | null;
  /** How many results this band may contribute. */
  budget: number;
  /** One phrase naming the band, for the summary line. */
  label: string;
};

/**
 * Where this client is, as country codes.
 *
 * Provinces collapse to their country: a client in CA-ON and CA-QC is a
 * Canadian client searching Canada once, not twice.
 */
export function homeCountries(jurisdictions: readonly string[] | null | undefined): string[] {
  const codes = (jurisdictions ?? []).map(countryOf).filter((c): c is string => c !== null);
  return [...new Set(codes)];
}

/**
 * Split a result budget between home and the rest of the continent.
 *
 * Home takes two thirds. That is a judgement, not a measurement: a consultant
 * spends most of their week on calls their client can actually win, and the
 * home country is where eligibility is least likely to be the reason a call
 * dies. The remaining third is what keeps the continent visible — including
 * multilateral funders, which are frequently the only cross-border money a
 * nonprofit can realistically reach.
 *
 * A client with no location gets one undifferentiated band. Splitting a search
 * by a home country we do not know would be inventing one.
 */
export function retrievalBands(
  jurisdictions: readonly string[] | null | undefined,
  total: number,
): Band[] {
  const home = homeCountries(jurisdictions).filter((c) => AMERICAS_SET.has(c));

  if (home.length === 0) {
    return [{ key: "americas", countries: [...AMERICAS], budget: total, label: "the Americas" }];
  }

  const homeBudget = Math.max(1, Math.round((total * 2) / 3));
  const rest = AMERICAS.filter((c) => !home.includes(c));

  return [
    { key: "home", countries: home, budget: homeBudget, label: home.join(", ") },
    {
      key: "americas",
      countries: rest,
      budget: Math.max(0, total - homeBudget),
      label: "the rest of the Americas",
    },
  ];
}

/**
 * Which band a grant belongs to, for grouping results the consultant reads.
 *
 * Derived from the grant's country rather than carried from retrieval, because
 * the profile can change between a run and the next time the page is opened,
 * and a location label that disagrees with the country beside it is worse than
 * no label.
 */
export function bandOf(
  grantCountry: string | null | undefined,
  jurisdictions: readonly string[] | null | undefined,
): Band["key"] {
  const code = countryOf(grantCountry);
  const home = homeCountries(jurisdictions);
  return code !== null && home.includes(code) ? "home" : "americas";
}
