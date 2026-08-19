/**
 * A labelled corpus for measuring retrieval, not a sample of the real one.
 *
 * Hand-written on purpose. Judging the live catalog would need either a human
 * reading four hundred grants per run or a model standing in for one, and a
 * model-judged eval measures the judge as much as the retriever — the number
 * moves when the judge changes and nobody can tell why. These labels never
 * move, so a change in the score is always a change in retrieval.
 *
 * The corpus is built around the three cases that separate hybrid retrieval
 * from keyword search, because a corpus of easy cases would score ~1.0 for
 * both arms and prove nothing:
 *
 *   1. VOCABULARY GAP — the grant means what the client does but shares no
 *      word with the profile ("climate resilience" vs "environment"). Keyword
 *      search cannot find these at all.
 *   2. LEXICAL TRAP — the grant contains the client's exact words and is
 *      irrelevant ("Environmental Impact Statement filing"). Keyword search
 *      ranks these highly; they are the false positives that make a consultant
 *      stop trusting a results page.
 *   3. PLAIN HIT — shares both words and meaning. Both arms should find these,
 *      and an arm that misses one is broken.
 *
 * `relevantTo` is the judgement: would this consultant spend an hour reading
 * this call for this client? It is deliberately about usefulness, not about
 * eligibility — eligibility is decided later, by rules, and mixing the two
 * would make a retrieval score move when an unrelated deadline passed.
 */

export type EvalProfile = {
  key: string;
  label: string;
  sectors: string[];
  jurisdictions: string[];
  stage: string;
  capabilities: string;
  beneficiaries: string;
};

export type EvalGrant = {
  externalId: string;
  title: string;
  summary: string;
  country: string;
  /** Profile keys this grant is genuinely worth reading for. */
  relevantTo: string[];
  /** Why this row is in the corpus, so a future reader can judge the label. */
  role: "vocabulary-gap" | "lexical-trap" | "plain-hit" | "distractor" | "cross-language";
  /**
   * The grant's own language. Lexical indexing is per language, so an English
   * query cannot reach a French or Spanish row through the word side at all —
   * these exist to test the claim in ADR-0004 that cross-language matching is
   * the vector side's job. That claim was asserted and never measured.
   */
  language?: "en" | "fr" | "es";
};

export const EVAL_PROFILES: EvalProfile[] = [
  {
    key: "greenspace",
    label: "Urban environmental nonprofit",
    sectors: ["environment", "public-places", "community"],
    jurisdictions: ["CA-ON"],
    stage: "nonprofit",
    capabilities: "We restore ravines and run volunteer tree-planting days across the city.",
    beneficiaries: "city residents, especially in low-income neighbourhoods",
  },
  {
    key: "youtharts",
    label: "Youth arts charity",
    sectors: ["arts", "education", "community"],
    jurisdictions: ["CA-ON"],
    stage: "charity",
    capabilities: "After-school music and theatre programs in six schools.",
    beneficiaries: "students aged 10 to 18",
  },
  {
    key: "clinic",
    label: "Community health clinic",
    sectors: ["health-wellbeing", "community"],
    jurisdictions: ["US"],
    stage: "nonprofit",
    capabilities: "Primary care and mental health services on a sliding scale.",
    beneficiaries: "uninsured adults",
  },
];

export const EVAL_GRANTS: EvalGrant[] = [
  // ── greenspace ────────────────────────────────────────────────────────────
  {
    externalId: "g-plain-1",
    title: "Community Environment Fund",
    summary:
      "Supports community organizations improving local green space, planting trees and restoring natural areas in urban neighbourhoods.",
    country: "CA",
    relevantTo: ["greenspace"],
    role: "plain-hit",
  },
  {
    externalId: "g-vocab-1",
    title: "Urban Climate Resilience Program",
    summary:
      "Funding for cities and their partners to expand tree canopy, cool neighbourhoods during heat waves and reduce flood risk through naturalized land.",
    country: "CA",
    relevantTo: ["greenspace"],
    role: "vocabulary-gap",
  },
  {
    externalId: "g-vocab-2",
    title: "Naturalization and Habitat Stewardship Grants",
    summary:
      "For volunteer-led groups rehabilitating degraded ravines, shorelines and meadows, including native planting and invasive species removal.",
    country: "CA",
    relevantTo: ["greenspace"],
    role: "vocabulary-gap",
  },
  {
    externalId: "g-trap-1",
    title: "Environmental Impact Statement Filing Assistance",
    summary:
      "Reimburses pipeline and mining proponents for consultant fees incurred preparing environmental impact statements for federal review.",
    country: "CA",
    relevantTo: [],
    role: "lexical-trap",
  },
  {
    externalId: "g-trap-2",
    title: "Public Places Signage Compliance Fund",
    summary:
      "Covers the cost of replacing regulatory signage in public places to meet updated municipal bylaw formatting requirements.",
    country: "CA",
    relevantTo: [],
    role: "lexical-trap",
  },

  // ── youtharts ─────────────────────────────────────────────────────────────
  {
    externalId: "g-plain-2",
    title: "Youth Arts Education Grant",
    summary:
      "Supports charities delivering arts education to school-aged young people, including music, theatre and visual arts programming.",
    country: "CA",
    relevantTo: ["youtharts"],
    role: "plain-hit",
  },
  {
    externalId: "g-vocab-3",
    title: "Creative Futures for Adolescents",
    summary:
      "Multi-year support for organizations running after-school studio and performance programming for teenagers in underserved schools.",
    country: "CA",
    relevantTo: ["youtharts"],
    role: "vocabulary-gap",
  },
  {
    externalId: "g-vocab-4",
    title: "Instrument Lending Library Support",
    summary:
      "Helps organizations acquire and maintain a stock of band and orchestral instruments loaned to students who cannot afford their own.",
    country: "CA",
    relevantTo: ["youtharts"],
    role: "vocabulary-gap",
  },
  {
    externalId: "g-trap-3",
    title: "Martial Arts Facility Renovation Program",
    summary:
      "Capital funding for commercial martial arts studios upgrading flooring, ventilation and change rooms to current safety standards.",
    country: "CA",
    relevantTo: [],
    role: "lexical-trap",
  },
  {
    externalId: "g-trap-4",
    title: "Continuing Education Tuition Rebate",
    summary:
      "A rebate paid directly to individual adult learners enrolled in accredited continuing education courses at recognized colleges.",
    country: "CA",
    relevantTo: [],
    role: "lexical-trap",
  },

  // ── clinic ────────────────────────────────────────────────────────────────
  {
    externalId: "g-plain-3",
    title: "Community Health Center Expansion",
    summary:
      "Supports nonprofit health centers expanding primary care and behavioral health services for uninsured and underinsured patients.",
    country: "US",
    relevantTo: ["clinic"],
    role: "plain-hit",
  },
  {
    externalId: "g-vocab-5",
    title: "Integrated Behavioral Care in Safety-Net Settings",
    summary:
      "Funds clinics embedding counsellors alongside primary care providers to reach adults who would not otherwise seek treatment.",
    country: "US",
    relevantTo: ["clinic"],
    role: "vocabulary-gap",
  },
  {
    externalId: "g-vocab-6",
    title: "Sliding Scale Care Access Initiative",
    summary:
      "Offsets the cost of treating patients without insurance coverage at nonprofit medical practices in medically underserved areas.",
    country: "US",
    relevantTo: ["clinic"],
    role: "vocabulary-gap",
  },
  {
    externalId: "g-trap-5",
    title: "Corporate Wellbeing and Health Benefits Advisory",
    summary:
      "Subsidizes consulting for employers redesigning staff health and wellbeing benefit packages and workplace wellness programming.",
    country: "US",
    relevantTo: [],
    role: "lexical-trap",
  },
  {
    externalId: "g-trap-6",
    title: "Community Bank Lending Capacity Fund",
    summary:
      "Capital for community development banks expanding small business lending in rural counties.",
    country: "US",
    relevantTo: [],
    role: "lexical-trap",
  },

  // ── distractors: plausible funding, wrong for everyone here ───────────────
  {
    externalId: "g-dist-1",
    title: "Advanced Semiconductor Packaging Research",
    summary:
      "Supports industry-academic consortia developing next-generation chip packaging and thermal management techniques.",
    country: "US",
    relevantTo: [],
    role: "distractor",
  },
  {
    externalId: "g-dist-2",
    title: "Commercial Fisheries Vessel Modernization",
    summary: "Assists licensed fishing enterprises replacing engines and refrigeration systems.",
    country: "CA",
    relevantTo: [],
    role: "distractor",
  },
  {
    externalId: "g-dist-3",
    title: "Highway Bridge Deck Rehabilitation",
    summary:
      "Provincial transfers to municipalities for structural repair of bridge decks on designated highway corridors.",
    country: "CA",
    relevantTo: [],
    role: "distractor",
  },
  {
    externalId: "g-dist-4",
    title: "Export Market Development for Manufacturers",
    summary:
      "Reimburses small manufacturers for trade show attendance and market entry costs in new export markets.",
    country: "CA",
    relevantTo: [],
    role: "distractor",
  },

  // ── cross-language: relevant, and unreachable by any English word ─────────
  // A consultant in Ontario should see a Quebec program that funds exactly
  // what their client does. Nothing in these rows matches an English profile
  // lexically, so anything found here was found by meaning.
  {
    externalId: "g-xlang-1",
    title: "Programme de verdissement des milieux urbains",
    summary:
      "Soutien aux organismes sans but lucratif qui plantent des arbres, restaurent les ravins et rafraîchissent les quartiers défavorisés.",
    country: "CA",
    language: "fr",
    relevantTo: ["greenspace"],
    role: "cross-language",
  },
  {
    externalId: "g-xlang-2",
    title: "Fondo de artes juveniles en barrios",
    summary:
      "Apoya a organizaciones que ofrecen talleres de música y teatro para adolescentes fuera del horario escolar.",
    country: "MX",
    language: "es",
    relevantTo: ["youtharts"],
    role: "cross-language",
  },
  {
    externalId: "g-xlang-3",
    title: "Programme d'accès aux soins de première ligne",
    summary:
      "Finance les cliniques communautaires qui traitent des adultes sans assurance, selon un barème adapté au revenu.",
    country: "CA",
    language: "fr",
    relevantTo: ["clinic"],
    role: "cross-language",
  },
  {
    externalId: "g-xlang-4",
    title: "Programme de modernisation des ponts routiers",
    summary:
      "Aide financière aux municipalités pour la réfection structurale des tabliers de ponts sur le réseau routier.",
    country: "CA",
    language: "fr",
    relevantTo: [],
    role: "distractor",
  },
];

export const EVAL_SOURCE_KEY = "eval-retrieval-corpus";

/** How many relevant rows exist for a profile — the denominator for recall. */
export function relevantCount(profileKey: string): number {
  return EVAL_GRANTS.filter((g) => g.relevantTo.includes(profileKey)).length;
}

/**
 * Relevant rows written in a language the profile is not in.
 *
 * Reported separately because it measures a specific architectural claim
 * rather than general quality: an English query cannot reach these through the
 * lexical index at all, so recall here is recall of the vector side alone.
 */
export function crossLanguageCount(profileKey: string): number {
  return EVAL_GRANTS.filter(
    (g) => g.relevantTo.includes(profileKey) && (g.language ?? "en") !== "en",
  ).length;
}
