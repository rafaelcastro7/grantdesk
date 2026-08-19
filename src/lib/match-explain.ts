/**
 * Why is this call in front of me?
 *
 * The incumbent's best-documented weakness is the answer to this question. Its
 * match score is a number with nothing behind it, and reviewers describe
 * spending "quite a bit of time diving into potential matches to filter out
 * funders that don't match" — which is the work the score was supposed to
 * remove. A score you have to re-verify by hand has negative value: it costs a
 * click and buys nothing.
 *
 * So a match here states two separate things, and never blurs them:
 *
 *   ELIGIBILITY — may this client apply? Decided by rules (src/lib/eligibility).
 *   RELEVANCE   — is this worth an hour? That is this file.
 *
 * Relevance is reported as the client's own words found in the funder's text,
 * or as an honest admission that there were none and the match came from
 * meaning alone. Both are checkable by the consultant in a second, which is the
 * whole point: the claim is small enough to verify at a glance.
 */

/** Slugs are how sectors are stored; funders write words. */
function humanize(term: string): string {
  return term.trim().replace(/[-_]+/g, " ").toLowerCase();
}

/** Escape everything a sector could contain that a regex would read as syntax. */
function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which of the client's terms this funder's own text actually contains.
 *
 * Word-boundary matching, not substring: the predecessor's search let "nsf"
 * match "tra**nsf**er", and a relevance claim built on that reads as noise the
 * first time a consultant checks one.
 *
 * Multi-word terms are matched loosely on their words in order ("public
 * places" also matches "public green places"), because a funder writes prose
 * and a profile stores a label.
 */
export function matchedTerms(
  terms: readonly string[] | null | undefined,
  text: string | null | undefined,
): string[] {
  if (!text) return [];
  const haystack = text.toLowerCase();

  const found: string[] = [];
  for (const raw of terms ?? []) {
    const term = humanize(raw);
    if (term.length < 3) continue;

    // Singular and plural both count: a funder writing "communities" is
    // answering a profile that says "community". A trailing "y" is dropped
    // first, because English does not simply append an "s" there — matching on
    // the stem covers community/communities and charity/charities alike.
    const words = term
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => escape(word.endsWith("y") ? word.slice(0, -1) : word));
    const pattern = new RegExp(`\\b${words.join("\\w*\\s+(?:\\w+\\s+){0,2}")}\\w*`, "i");
    if (pattern.test(haystack) && !found.includes(term)) found.push(term);
  }
  return found;
}

export type Relevance = {
  terms: string[];
  /** One line a consultant can check against the call in a second. */
  statement: string;
};

/**
 * The sentence shown under a result.
 *
 * A vector-only match — no shared wording at all — is the most valuable kind
 * and the easiest to distrust, so it says so plainly rather than hiding behind
 * a number. That is the case the incumbent's keyword-shaped tooling cannot find
 * at all.
 */
export function explainRelevance(
  sectors: readonly string[] | null | undefined,
  grantText: string | null | undefined,
  retrieval: { lexicalRank?: number | null; vectorRank?: number | null } | null | undefined,
): Relevance {
  return relevanceFrom(matchedTerms(sectors, grantText), retrieval);
}

/**
 * The same sentence, built from terms already recorded against the match.
 *
 * The UI reads these rather than recomputing them, because a profile can be
 * edited after a match was decided — and a stated reason that silently
 * rewrites itself to fit the current profile is not a reason at all.
 */
export function relevanceFrom(
  terms: readonly string[],
  retrieval: { lexicalRank?: number | null; vectorRank?: number | null } | null | undefined,
): Relevance {
  if (terms.length > 0) {
    return {
      terms: [...terms],
      statement: `This funder's own text mentions ${list(terms)}.`,
    };
  }
  if (retrieval?.vectorRank) {
    return {
      terms: [],
      statement:
        "No shared wording — this came up because it means something close to what this client does. Worth a skim before a full read.",
    };
  }
  return { terms: [], statement: "We cannot say what made this relevant." };
}

function list(items: readonly string[]): string {
  const last = items.at(-1);
  if (!last) return "";
  if (items.length === 1) return `"${last}"`;
  return `${items
    .slice(0, -1)
    .map((t) => `"${t}"`)
    .join(", ")} and "${last}"`;
}
