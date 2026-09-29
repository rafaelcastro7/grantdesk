/**
 * Is a "verbatim" quote actually on the page?
 *
 * The extraction prompt asks the model for the funder's exact words, and
 * those words are then shown to the consultant and fed to drafting and
 * eligibility reading as the funder's own. A paraphrase or an invention
 * presented that way is worse than no quote, so each one is checked against
 * the text that was read, after normalising what differs harmlessly:
 * whitespace, case, curly quotes and dashes.
 */

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** A quote shorter than this proves nothing about the page, so it is not checked. */
const MIN_CHECKED = 12;

export function quoteAppearsIn(quote: string, source: string): boolean {
  const q = normalise(quote)
    .replace(/^["']|["']$/g, "")
    .replace(/\.\.\.|…/g, "…");
  if (q.length < MIN_CHECKED) return true;
  const hay = normalise(source);
  // An elided quote ("A … B") is verified piece by piece, in order.
  let from = 0;
  for (const piece of q
    .split("…")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const at = hay.indexOf(piece, from);
    if (at < 0) return false;
    from = at + piece.length;
  }
  return true;
}

/**
 * Drops quotes the source does not contain and says which, so the consultant
 * sees "not found on the page" rather than an invented sentence in quote marks.
 */
export function verifyQuotes<T extends { label: string; sourceQuote: string | null }>(
  items: readonly T[],
  source: string,
): { items: T[]; unverified: string[] } {
  const unverified: string[] = [];
  const checked = items.map((item) => {
    if (!item.sourceQuote || quoteAppearsIn(item.sourceQuote, source)) return item;
    unverified.push(item.label);
    return { ...item, sourceQuote: null };
  });
  return { items: checked, unverified };
}
