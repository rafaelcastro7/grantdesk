import type { SourceAdapter, SourceGrant } from "./types";

/**
 * Ontario's live list of funding opportunities (Transfer Payment Ontario).
 *
 * One page, one `<h2>` per program, each with the same published anatomy:
 * a status badge, the administering ministry, then `<h3>` sections for
 * Deadline, Description, Eligibility, Program guidelines and Contacts. That
 * anatomy is what makes this worth an adapter: every field a consultant needs
 * to screen a call is on the page, in the funder's own words.
 *
 * Eligibility stays prose (eligibilityNote) and applicant types stay empty —
 * reading structured eligibility out of prose would let a regex create a hard
 * gate (ADR-0004).
 */

export const ONTARIO_PAGE =
  "https://www.ontario.ca/page/available-funding-opportunities-ontario-government";

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";

export type OntarioProgram = {
  title: string;
  status: "open" | "closed";
  ministry: string | null;
  deadline: string | null;
  deadlineText: string | null;
  description: string;
  eligibility: string | null;
  amountMin: number | null;
  amountMax: number | null;
  documents: Array<{ label: string; url: string }>;
  contact: string | null;
};

function decode(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x27;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Block-aware text: list items and paragraphs keep their line breaks. */
export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<li[^>]*>/gi, "\n• ")
      .replace(/<\/(p|li|ul|ol|div|h\d)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export function parseDeadline(text: string | null): string | null {
  if (!text) return null;
  const dates = [...text.matchAll(new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2}),?\\s+(\\d{4})`, "g"))];
  const last = dates.at(-1);
  if (!last) return null;
  const month = MONTHS.split("|").indexOf(last[1]!) + 1;
  return `${last[3]}-${String(month).padStart(2, "0")}-${last[2]!.padStart(2, "0")}`;
}

const MONEY = String.raw`\$\s?([\d,]+(?:\.\d+)?)\s*(million|M\b)?`;

function money(digits: string, scale: string | undefined): number {
  const value = Number(digits.replace(/,/g, ""));
  return scale ? value * 1_000_000 : value;
}

/**
 * The per-award range, as the funder states it: "range from $5,000 to
 * $50,000", "maximum amount of funding … is $5 million", "up to $400,000".
 * A program's total envelope ("a $500 million program") is deliberately not
 * read as an award ceiling.
 */
export function parseAmounts(text: string): { min: number | null; max: number | null } {
  const range = new RegExp(`(?:\\bfrom\\s+)?${MONEY}\\s+(?:to|and|–|-)\\s+${MONEY}`, "i").exec(
    text,
  );
  if (range) {
    return { min: money(range[1]!, range[2]), max: money(range[3]!, range[4]) };
  }
  const ceiling = new RegExp(
    `\\b(?:maximum[^$.]{0,50}?|up to\\s+|cap(?:ped)? at\\s+|no more than\\s+)${MONEY}`,
    "gi",
  );
  let max: number | null = null;
  for (const match of text.matchAll(ceiling)) {
    const value = money(match[1]!, match[2]);
    if (Number.isFinite(value) && value > 0 && (max === null || value > max)) max = value;
  }
  return { min: null, max };
}

function sections(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = html.split(/<h3[^>]*>/i).slice(1);
  for (const part of parts) {
    const end = part.search(/<\/h3>/i);
    if (end < 0) continue;
    const heading = htmlToText(part.slice(0, end)).toLowerCase();
    out.set(heading, part.slice(end + 5));
  }
  return out;
}

function links(html: string, base: string): Array<{ label: string; url: string }> {
  const found: Array<{ label: string; url: string }> = [];
  for (const match of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decode(match[1]!);
    if (href.startsWith("mailto:") || href.startsWith("#")) continue;
    const url = new URL(href, base).toString();
    const label = htmlToText(match[2]!) || url;
    if (!found.some((l) => l.url === url)) found.push({ label, url });
  }
  return found;
}

export function parseOntarioPage(html: string): OntarioProgram[] {
  const bodyStart = html.indexOf('class="body-field"');
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;

  const programs: OntarioProgram[] = [];
  for (const chunk of body.split(/<h2[^>]*>/i).slice(1)) {
    const end = chunk.search(/<\/h2>/i);
    if (end < 0) continue;
    const title = htmlToText(chunk.slice(0, end));
    const rest = chunk.slice(end + 5);

    const badge = /Status:\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/i.exec(rest);
    if (!badge) continue;
    const status = /closed/i.test(badge[1]!) ? "closed" : "open";

    const beforeSections = rest.split(/<h3/i)[0] ?? "";
    // Only a line that names a body counts; a stray intro sentence is not a funder.
    const ministry =
      [...beforeSections.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((m) => htmlToText(m[1]!))
        .find(
          (p) =>
            p.length < 160 &&
            /^(ministry|office|treasury|cabinet|secretariat|agency)\b|\b(ministry|secretariat)\b/i.test(
              p,
            ),
        ) ?? null;

    const byHeading = sections(rest);
    const get = (pattern: RegExp) => {
      for (const [heading, content] of byHeading) if (pattern.test(heading)) return content;
      return null;
    };

    const deadlineHtml = get(/deadline|dates?|intake/);
    const deadlineText = deadlineHtml ? htmlToText(deadlineHtml) : null;
    const description = htmlToText(get(/description|about|overview/) ?? "");
    const eligibilityHtml = get(/eligib/);
    const eligibility = eligibilityHtml ? htmlToText(eligibilityHtml) : null;
    const guidelines = get(/guideline|how to apply|resources|documents/);
    const contactHtml = get(/contact/);
    const contact = contactHtml
      ? [
          htmlToText(contactHtml),
          ...[...contactHtml.matchAll(/mailto:([^"?]+)/gi)].map((m) => m[1]!),
        ]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
      : null;

    programs.push({
      title,
      status,
      ministry,
      deadline: parseDeadline(deadlineText),
      deadlineText,
      description,
      eligibility,
      ...(() => {
        const { min, max } = parseAmounts(htmlToText(rest));
        return { amountMin: min, amountMax: max };
      })(),
      documents: guidelines ? links(guidelines, ONTARIO_PAGE) : [],
      contact,
    });
  }
  return programs;
}

/** A link that lands on the program's own heading, not the top of a long page. */
export function programUrl(title: string): string {
  return `${ONTARIO_PAGE}#:~:text=${encodeURIComponent(title)}`;
}

export const ontarioTpon: SourceAdapter = {
  key: "ontario-tpon",
  label: "Ontario — Transfer Payment Ontario",
  market: "CA",
  cadenceHours: 24,
  description:
    "Ontario government funding opportunities with status, deadline, eligibility, guidelines and contacts.",

  async harvest({ limit = 500 } = {}) {
    const response = await fetch(ONTARIO_PAGE, {
      headers: { "user-agent": "Mozilla/5.0 (GrantDesk catalog refresh)" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`ontario.ca HTTP ${response.status}`);
    const programs = parseOntarioPage(await response.text());
    if (programs.length === 0) {
      throw new Error("ontario.ca page parsed to zero programs — its layout has changed");
    }

    const ministries = new Map<string, string>();
    const grants: SourceGrant[] = programs.slice(0, limit).map((p) => {
      const funder = p.ministry ?? "Government of Ontario";
      ministries.set(funder, funder);
      const summary = [p.description, p.deadlineText ? `Deadline: ${p.deadlineText}` : null]
        .filter(Boolean)
        .join("\n\n");
      return {
        funderName: funder,
        funderCountry: "CA",
        title: p.title.slice(0, 500),
        summary: summary.slice(0, 8000),
        url: programUrl(p.title),
        country: "CA",
        currency: "CAD",
        amountMin: p.amountMin,
        amountMax: p.amountMax,
        deadline: p.deadline,
        language: "en",
        eligibilityNote: p.eligibility?.slice(0, 4000) ?? null,
        status: p.status,
        documents: p.documents,
        contact: p.contact?.slice(0, 1000) ?? null,
        externalId: `ontario-tpon:${p.title}`,
      };
    });

    return {
      funders: [...ministries.keys()].map((name) => ({
        name,
        country: "CA",
        jurisdiction: "CA-ON",
        category: "Ontario government ministry",
        website: ONTARIO_PAGE,
      })),
      grants,
    };
  },
};
