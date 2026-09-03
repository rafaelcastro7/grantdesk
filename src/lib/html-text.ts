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

/** How keen this link's own words are to be an application/eligibility page. */
const RELATED_PATTERN =
  /how to apply|application (form|process|guide|guidelines)|apply now|eligib|guideline|criteria|application requirements|submission (process|guide)|how to submit|instructions/i;

/**
 * A second, looser pass for when the narrow pattern already proved this page
 * is a real funding call worth digging into further, but still turned up
 * nothing about how to actually apply. Still same-origin only — that
 * boundary never loosens — only the wording bar drops, to the kind of link
 * text a funder actually uses for "read more here" without saying the word
 * "apply": "program details", "funding guide", "learn more", "requirements".
 */
const BROAD_RELATED_PATTERN =
  /details|learn more|requirements|program guide|funding guide|read more|full (details|guidelines)|more information/i;

export type RelatedLinksOptions = {
  limit?: number;
  /** URLs already fetched in an earlier pass — never suggested again. */
  exclude?: ReadonlySet<string>;
  /** Use the looser wording bar for a second pass over the same page. */
  broad?: boolean;
};

/**
 * Links on a funder's page worth reading too, before deciding a call has
 * nothing more to say. A funding notice frequently states the offer and
 * points elsewhere for "How to Apply" or the eligibility rules — reading
 * only the page the catalog happened to store then makes a real, published
 * requirement look like it was never stated anywhere.
 *
 * Bounded twice over: only the same site (a link to an unrelated domain is
 * exactly the kind of thing worth NOT fetching automatically), and only
 * links whose own text says what this is for — a wall of navigation links to
 * "Contact us" or "Privacy Policy" is not read just because it exists on the
 * page.
 */
export function relatedLinks(
  html: string,
  baseUrl: string,
  options: RelatedLinksOptions = {},
): string[] {
  const { limit = 3, exclude, broad = false } = options;
  const wordBar = broad ? BROAD_RELATED_PATTERN : RELATED_PATTERN;

  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  const found = new Set<string>();
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) && found.size < limit) {
    const [, href, rawText] = match;
    if (!href || !rawText) continue;
    const text = decodeEntities(rawText.replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (!wordBar.test(text)) continue;

    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (resolved.origin !== origin) continue;
    resolved.hash = "";
    const url = resolved.toString();
    if (url === baseUrl) continue;
    if (exclude?.has(url)) continue;
    found.add(url);
  }
  return [...found];
}
