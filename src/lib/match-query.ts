/**
 * Turning a client profile into the two queries retrieval needs.
 *
 * They are not the same string, because the two halves of retrieval read text
 * differently. The lexical side wants a disjunction of the client's own terms;
 * the semantic side wants prose, because an embedding of comma-separated slugs
 * describes a list, not an organization.
 */

export type ProfileForQuery = {
  sectors?: readonly string[] | null;
  jurisdictions?: readonly string[] | null;
  stage?: string | null;
  capabilities?: string | null;
  beneficiaries?: string | null;
};

/** Slugs are how we store sectors; "public-places" is not a phrase anyone searches. */
function humanize(term: string): string {
  return term.trim().replace(/[-_]+/g, " ").toLowerCase();
}

/**
 * A `websearch_to_tsquery` string.
 *
 * Disjunctive on purpose. Space means AND in that parser, so the obvious
 * "education environment community" would demand all three words in one grant
 * and return almost nothing — the exact failure that makes a keyword search
 * feel broken. Multi-word terms are quoted so they stay phrases.
 */
export function lexicalQuery(profile: ProfileForQuery): string {
  const terms = (profile.sectors ?? [])
    .map(humanize)
    .filter((term) => term.length > 1)
    .map((term) => (term.includes(" ") ? `"${term}"` : term));

  return [...new Set(terms)].join(" or ");
}

/**
 * The text that gets embedded.
 *
 * Written as sentences rather than fields because that is what the model was
 * trained on, and because the same phrasing is what a grant description looks
 * like — the closer the two are in form, the more of the distance between them
 * is actually about meaning.
 */
export function semanticQuery(profile: ProfileForQuery): string {
  const parts: string[] = [];
  const sectors = (profile.sectors ?? []).map(humanize).filter(Boolean);

  if (sectors.length > 0) parts.push(`An organization working in ${sectors.join(", ")}.`);
  if (profile.stage) parts.push(`It is a ${humanize(profile.stage)}.`);
  if ((profile.jurisdictions ?? []).length > 0) {
    parts.push(`It operates in ${(profile.jurisdictions ?? []).join(", ")}.`);
  }
  if (profile.capabilities?.trim()) parts.push(profile.capabilities.trim());
  if (profile.beneficiaries?.trim()) parts.push(`It serves ${profile.beneficiaries.trim()}`);

  return parts.join(" ").slice(0, 4000);
}

/** Neither half of retrieval can run on nothing; say so rather than returning zero results. */
export function hasQueryableProfile(profile: ProfileForQuery): boolean {
  return lexicalQuery(profile).length > 0 || semanticQuery(profile).length > 0;
}
