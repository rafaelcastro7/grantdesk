/**
 * One vocabulary for "who is allowed to apply", shared by every source.
 *
 * Each funder names these differently — Grants.gov uses numbered codes,
 * Innovation Canada uses prose, a provincial portal uses its own list. Without
 * a shared vocabulary the eligibility rule would be comparing a US code to a
 * Canadian sentence, so every adapter maps into this set on the way in and the
 * rule only ever compares canonical values.
 *
 * The set is deliberately coarse. A finer taxonomy would be more accurate in
 * principle and less accurate in practice, because the mapping from each
 * source would start guessing.
 */

export const APPLICANT_TYPES = [
  "nonprofit",
  "charity",
  "for-profit",
  "small-business",
  "academic",
  "government",
  "indigenous",
  "individual",
] as const;

export type ApplicantType = (typeof APPLICANT_TYPES)[number];

const IS_APPLICANT_TYPE = new Set<string>(APPLICANT_TYPES);

export function isApplicantType(value: string): value is ApplicantType {
  return IS_APPLICANT_TYPE.has(value);
}

/**
 * Grants.gov applicant-type codes. Sourced from the live `eligibilities` facet
 * rather than transcribed from documentation, so it matches what the API
 * actually returns.
 *
 * Code 99 ("Unrestricted") maps to every type: it is the funder explicitly
 * saying anyone may apply, which must pass the gate rather than skip it.
 * Code 25 ("Others — see the text field") maps to nothing, because it means
 * the machine-readable answer is incomplete and only the prose can settle it.
 */
const GRANTS_GOV_CODES: Record<string, readonly ApplicantType[]> = {
  "00": ["government"],
  "01": ["government"],
  "02": ["government"],
  "04": ["government"],
  "05": ["government", "academic"],
  "06": ["academic", "government"],
  "07": ["indigenous", "government"],
  "08": ["government"],
  "11": ["indigenous", "nonprofit"],
  "12": ["nonprofit", "charity"],
  "13": ["nonprofit"],
  "20": ["academic"],
  "21": ["individual"],
  "22": ["for-profit"],
  "23": ["small-business", "for-profit"],
  "25": [],
  "99": [...APPLICANT_TYPES],
};

/**
 * True when the structured list is not the whole answer: code 25 ("Others —
 * see the text field") or a code this table does not know. The listed types
 * are still definitely eligible; anyone else may be, and only the prose says.
 */
export function grantsGovListIsOpenEnded(codes: readonly string[]): boolean {
  return codes.some((code) => {
    const mapped = GRANTS_GOV_CODES[code.trim()];
    return mapped === undefined || mapped.length === 0;
  });
}

/**
 * Grants.gov funding-instrument codes, as the API returns them. The description
 * the feed sends is preferred; this only covers a missing one.
 */
const GRANTS_GOV_INSTRUMENTS: Record<string, string> = {
  G: "grant",
  CA: "cooperative agreement",
  PC: "procurement contract",
  O: "other",
};

export function fromGrantsGovInstruments(
  instruments: ReadonlyArray<{ id?: string; description?: string }>,
): string[] {
  const out = new Set<string>();
  for (const item of instruments) {
    const label =
      item.description?.trim().toLowerCase() ||
      GRANTS_GOV_INSTRUMENTS[item.id?.trim().toUpperCase() ?? ""];
    if (label) out.add(label);
  }
  return [...out].sort();
}

export function fromGrantsGovCodes(codes: readonly string[]): ApplicantType[] {
  const out = new Set<ApplicantType>();
  for (const code of codes) {
    for (const type of GRANTS_GOV_CODES[code.trim()] ?? []) out.add(type);
  }
  return [...out].sort();
}

/**
 * Free prose to canonical types, for sources that publish eligibility as a
 * sentence. Matching is substring-based on a lowercased haystack because these
 * strings are short labels ("Not-for-profit organizations, Indigenous groups"),
 * not documents.
 *
 * Returns an empty array when nothing matches, which the rules engine treats as
 * "unknown" rather than "nobody" — silence from a source must never be read as
 * a restriction the funder did not state.
 */
const PROSE_PATTERNS: ReadonlyArray<readonly [RegExp, ApplicantType]> = [
  [/not[- ]for[- ]profit|non[- ]?profit|osbl|sans but lucratif/i, "nonprofit"],
  [/charit|registered charity|organisme de bienfaisance/i, "charity"],
  [/small business|sme\b|pme\b|start[- ]?up/i, "small-business"],
  [/for[- ]profit|business|entreprise|corporation|compan/i, "for-profit"],
  [/universit|college|academic|research institut|école|school board/i, "academic"],
  [/municipal|government|province|federal|public sector|municipalit/i, "government"],
  [/indigenous|first nation|inuit|m[ée]tis|aboriginal|tribal|autochtone/i, "indigenous"],
  [/individual|sole proprietor|particulier/i, "individual"],
];

export function fromProse(text: string | null | undefined): ApplicantType[] {
  if (!text) return [];
  const out = new Set<ApplicantType>();
  for (const [pattern, type] of PROSE_PATTERNS) {
    if (pattern.test(text)) out.add(type);
  }
  return [...out].sort();
}

/**
 * The client's own stage, as extracted into their profile, expressed in the
 * same vocabulary. A registered charity is also a nonprofit, and both should
 * clear a gate that names either — so this expands rather than maps one to one.
 */
const STAGE_TO_TYPES: Record<string, readonly ApplicantType[]> = {
  nonprofit: ["nonprofit"],
  charity: ["charity", "nonprofit"],
  "registered-charity": ["charity", "nonprofit"],
  cooperative: ["nonprofit"],
  startup: ["small-business", "for-profit"],
  "small-business": ["small-business", "for-profit"],
  sme: ["small-business", "for-profit"],
  business: ["for-profit"],
  "for-profit": ["for-profit"],
  company: ["for-profit"],
  university: ["academic"],
  academic: ["academic"],
  research: ["academic"],
  municipality: ["government"],
  government: ["government"],
  "public-sector": ["government"],
  indigenous: ["indigenous"],
  "first-nation": ["indigenous"],
  individual: ["individual"],
};

export function fromClientStage(stage: string | null | undefined): ApplicantType[] {
  if (!stage) return [];
  const key = stage.trim().toLowerCase();
  const direct = STAGE_TO_TYPES[key];
  if (direct) return [...direct].sort();
  // An unrecognized stage still often contains a recognizable word.
  return fromProse(key);
}

const LABELS: Record<ApplicantType, string> = {
  nonprofit: "nonprofits",
  charity: "registered charities",
  "for-profit": "for-profit companies",
  "small-business": "small businesses",
  academic: "universities and colleges",
  government: "governments and public bodies",
  indigenous: "Indigenous organizations",
  individual: "individuals",
};

export function labelFor(type: ApplicantType): string {
  return LABELS[type];
}

/** "nonprofits and universities", for a sentence a consultant reads. */
export function listApplicantTypes(types: readonly ApplicantType[]): string {
  const labels = types.map(labelFor);
  const last = labels.at(-1);
  if (!last) return "";
  if (labels.length === 1) return last;
  return `${labels.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * A jurisdiction code, said the way a person would say it.
 *
 * Profiles store ISO-like codes because rules compare them. Prompts must not:
 * a model handed "CA-ON" wrote that the client operates in the
 * "California-Ontario region", which is the kind of sentence that reaches a
 * funder and is remembered. The codes are unambiguous to the eligibility
 * engine and genuinely ambiguous to a reader.
 */
const PLACE_NAMES: Record<string, string> = {
  CA: "Canada",
  US: "the United States",
  MX: "Mexico",
  BR: "Brazil",
  INTL: "internationally",
  "CA-AB": "Alberta, Canada",
  "CA-BC": "British Columbia, Canada",
  "CA-MB": "Manitoba, Canada",
  "CA-NB": "New Brunswick, Canada",
  "CA-NL": "Newfoundland and Labrador, Canada",
  "CA-NS": "Nova Scotia, Canada",
  "CA-NT": "the Northwest Territories, Canada",
  "CA-NU": "Nunavut, Canada",
  "CA-ON": "Ontario, Canada",
  "CA-PE": "Prince Edward Island, Canada",
  "CA-QC": "Quebec, Canada",
  "CA-SK": "Saskatchewan, Canada",
  "CA-YT": "Yukon, Canada",
};

export function placeName(code: string): string {
  const key = code.trim().toUpperCase();
  const known = PLACE_NAMES[key];
  if (known) return known;

  // An unknown subnational code still resolves its country, which is better
  // than handing the model a hyphenated pair to interpret however it likes.
  const [country, region] = key.split("-");
  const countryName = country ? PLACE_NAMES[country] : undefined;
  if (region && countryName) return `${region} (${countryName})`;
  return countryName ?? key;
}

/** "Ontario, Canada and the United States" — for a sentence, not a filter. */
export function listPlaces(codes: readonly string[]): string {
  const names = [...new Set(codes.map(placeName))];
  const last = names.at(-1);
  if (!last) return "";
  if (names.length === 1) return last;
  return `${names.slice(0, -1).join(", ")} and ${last}`;
}
