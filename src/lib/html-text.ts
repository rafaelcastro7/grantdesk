/**
 * Reduce a fetched page to the text worth sending to a model.
 *
 * Deliberately a small dependency-free reducer rather than a full extractor:
 * an organization's "about" page is mostly prose, and the failure mode we
 * actually care about is feeding a model 200 KB of navigation and cookie
 * banners, which both costs tokens and buries the two paragraphs that describe
 * what the organization does.
 *
 * If this proves too blunt on real pages, the upgrade path is trafilatura or
 * Crawl4AI — but that is a decision to make on evidence, not in advance.
 */

const DROP_BLOCKS =
  /<(script|style|noscript|svg|iframe|template|nav|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Elements whose boundaries are meaningful paragraph breaks once tags go. */
const BLOCK_BOUNDARY = /<\/?(p|div|section|article|li|tr|h[1-6]|br)\b[^>]*>/gi;

/**
 * Zero-width and byte-order marks: BOM, ZWSP, ZWNJ, ZWJ, word joiner.
 *
 * Built from a string so the source stays pure ASCII. Pasting the characters
 * themselves into a regex literal is unreviewable — they are invisible — and
 * trips both no-irregular-whitespace and no-misleading-character-class.
 */
/* Alternation rather than a character class: ZWJ is a joiner, and grouping it
   with its neighbours in a class is exactly what no-misleading-character-class
   warns about. */
const INVISIBLES = new RegExp(
  ["\\uFEFF", "\\u200B", "\\u200C", "\\u200D", "\\u2060"].join("|"),
  "g",
);

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

function decodeEntities(input: string): string {
  return input
    .replace(/&[a-z]+;|&#\d+;/gi, (match) => {
      const named = ENTITIES[match.toLowerCase()];
      if (named !== undefined) return named;
      const numeric = /^&#(\d+);$/.exec(match);
      if (numeric?.[1]) {
        const code = Number(numeric[1]);
        // Ignore control characters rather than emitting them into a prompt.
        if (code >= 32 && code <= 0x10ffff) return String.fromCodePoint(code);
      }
      return " ";
    })
    .replace(INVISIBLES, "");
}

export type HtmlTextOptions = {
  /** Hard ceiling on returned characters. Cuts on a paragraph edge when it can. */
  maxChars?: number;
};

export function htmlToText(html: string, options: HtmlTextOptions = {}): string {
  const maxChars = options.maxChars ?? 12_000;

  const withoutBlocks = html.replace(DROP_BLOCKS, " ");
  const withBreaks = withoutBlocks.replace(BLOCK_BOUNDARY, "\n");
  const withoutTags = withBreaks.replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(withoutTags);

  const paragraphs = decoded
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter((line) => line.length > 0);

  const text = paragraphs.join("\n");
  if (text.length <= maxChars) return text;

  // Prefer cutting at a paragraph boundary so the model never sees a sentence
  // sheared in half, which reads as corrupted input and degrades extraction.
  const truncated = text.slice(0, maxChars);
  const lastBreak = truncated.lastIndexOf("\n");
  return lastBreak > maxChars * 0.6 ? truncated.slice(0, lastBreak) : truncated;
}

/** The page's <title>, when it has one worth using. */
export function htmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) return null;
  const title = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
  return title.length > 0 ? title : null;
}
