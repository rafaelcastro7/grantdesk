import { z } from "zod";
import { htmlToText, htmlTitle, relatedLinks } from "@/lib/html-text";
import { callLlm } from "./llm";

/**
 * Read a funding call and record what it actually asks for.
 *
 * This is the difference between drafting and filling in a template. A generic
 * proposal outline — need, approach, budget, evaluation — is the same for every
 * funder and matches none of them. What a consultant is paid for is answering
 * *this* funder's questions in *this* funder's order, against the criteria
 * they published.
 *
 * So requirements are extracted with their own words attached. `sourceQuote` is
 * verbatim from the call, never paraphrased, because it is what gets quoted
 * back when someone asks why a draft says what it says.
 */

const RequirementSchema = z.object({
  label: z.unknown(),
  detail: z.unknown().optional(),
  kind: z.unknown().optional(),
  wordLimit: z.unknown().optional(),
  evaluationNote: z.unknown().optional(),
  sourceQuote: z.unknown().optional(),
  isCritical: z.unknown().optional(),
});

const ResponseSchema = z.object({
  requirements: z.array(RequirementSchema).default([]),
});

export type RequirementKind = "section" | "eligibility" | "attachment" | "criterion" | "process";

export type ExtractedRequirement = {
  label: string;
  detail: string | null;
  kind: RequirementKind;
  wordLimit: number | null;
  evaluationNote: string | null;
  sourceQuote: string | null;
  isCritical: boolean;
  sortOrder: number;
};

const KINDS = new Set<RequirementKind>([
  "section",
  "eligibility",
  "attachment",
  "criterion",
  "process",
]);

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * "500 words", "max 2 pages", "1,000 word limit". Pages are not words, so a
 * page count is left unset rather than converted by a ratio we made up.
 */
export function normalizeWordLimit(value: unknown): number | null {
  if (typeof value === "number")
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  if (typeof value !== "string") return null;
  const match = /(\d[\d,]*)\s*(?:-|\s)?\s*words?/i.exec(value);
  if (!match?.[1]) return null;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeKind(value: unknown): RequirementKind {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return KINDS.has(raw as RequirementKind) ? (raw as RequirementKind) : "section";
}

/**
 * Liberal at the boundary, canonical after it — the same lesson Phase 1 paid
 * for. A model that answers `"500 words"` where the schema wanted a number has
 * read the page correctly; rejecting it is a defect in the schema.
 */
export function parseRequirements(raw: string): ExtractedRequirement[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const parsed = ResponseSchema.parse(JSON.parse(cleaned));

  const out: ExtractedRequirement[] = [];
  const seen = new Set<string>();

  for (const item of parsed.requirements) {
    const label = text(item.label, 200);
    if (!label) continue;
    // The same heading listed twice is one requirement; a duplicate would
    // produce two sections asking the consultant the same question.
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      label,
      detail: text(item.detail, 2000),
      kind: normalizeKind(item.kind),
      wordLimit: normalizeWordLimit(item.wordLimit),
      evaluationNote: text(item.evaluationNote, 1000),
      sourceQuote: text(item.sourceQuote, 1000),
      isCritical: item.isCritical === true,
      sortOrder: out.length,
    });
  }

  return out;
}

const SYSTEM = `You read a funding call and list exactly what an applicant must provide.

You may be given more than one page — a funder's notice frequently states the
offer and links elsewhere for "How to Apply" or the eligibility rules, and
each page you are given is marked with its own "Source:" line. Read all of
them as one call. A requirement stated on the second page is exactly as real
as one stated on the first; do not treat the first page as primary and the
rest as background.

Record only what the call states. Do not add the sections a proposal "usually"
has — a requirement that is not on any given page is a defect, not a helpful
default.

For each requirement:
- label: the funder's own heading, as short as it appears (e.g. "Project Description").
- kind: one of
    "section"     — narrative the applicant writes and submits as part of the application
    "attachment"  — a document to upload (budget, financial statements, letters)
    "eligibility" — a condition the applicant must meet to apply at all
    "criterion"   — something the funder says they will score
    "process"     — instructions about the mechanics of applying itself: who to
                    contact, which form to fill in, where or how to submit it,
                    what happens after submission. Never "section" — there is
                    nothing to compose about "contact your regional office and
                    submit the form", and writing a paragraph elaborating on it
                    invents persuasive content around an instruction, not an
                    answer to anything the funder asked.
- detail: what the call says this must cover, in one or two sentences.
- wordLimit: the stated limit if there is one, otherwise null. Do not invent one.
- evaluationNote: how the funder says this will be assessed, if stated.
- sourceQuote: a short verbatim quote for this requirement, from whichever
  given page states it. Copy it exactly. This is checked against the page.
- isCritical: true only if the call says the application is rejected without it.

Merge conditions that restate one rule. A call that says an applicant must be a
501(c)(3) nonprofit is one eligibility requirement, not three — listing
"Applicant Status", "Nonprofit Status" and "501(c)(3) Status" separately gives a
consultant a list they cannot act on. Prefer the funder's own heading.

If the page is not a funding call, or lists no requirements, return an empty array.

Reply with a single JSON object: {"requirements":[...]} and nothing else.`;

export type RequirementExtraction = {
  requirements: ExtractedRequirement[];
  provenance: { source: string; title: string | null; extractedAt: string; model: string };
  /**
   * The plain text actually fed to the model, truncated for display. Kept so
   * that a call with nothing structured to extract can still show what was
   * read, in the app, rather than sending the consultant to the source page
   * to find out for themselves what we already looked at.
   */
  readText: string;
  /** Every URL actually fetched, in the order read — the primary page first. */
  sourcesRead: string[];
};

type Page = { url: string; title: string | null; text: string };
/** A fetched page, before its text is trimmed to the extraction budget. */
type FetchedPage = Page & { html: string };

const FETCH_HEADERS = {
  "User-Agent": "IIAL-GrantDesk/1.0 (+https://iial.ca; reads public funding calls)",
};

/**
 * The actual extraction call, over however many pages were read. Everything
 * above this decides *which* pages; this only ever sees plain text already
 * labeled by source, so it does not care whether that text came from one
 * fetch or four.
 */
async function extractFromPages(pages: Page[]): Promise<RequirementExtraction> {
  const primary = pages[0]!;

  const response = await callLlm({
    role: "extract",
    json: true,
    temperature: 0.1,
    maxTokens: 4000,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: pages
          .map((page) =>
            [
              `Source: ${page.url}`,
              page.title ? `Page title: ${page.title}` : null,
              "",
              "Call text:",
              page.text,
            ]
              .filter((line) => line !== null)
              .join("\n"),
          )
          .join("\n\n---\n\n"),
      },
    ],
    validate: (candidate) => {
      try {
        parseRequirements(candidate);
        return true;
      } catch {
        return false;
      }
    },
  });

  return {
    requirements: parseRequirements(response.text),
    // Every page read, labeled, not only the primary one — a consultant
    // checking "what did it actually read" has to see all of it, or a
    // requirement sourced from the second page looks unverifiable.
    readText: pages.map((page) => `=== ${page.url} ===\n${page.text.slice(0, 4000)}`).join("\n\n"),
    sourcesRead: pages.map((page) => page.url),
    provenance: {
      source: primary.url,
      title: primary.title,
      extractedAt: new Date().toISOString(),
      model: `${response.provider}/${response.model}`,
    },
  };
}

export async function extractRequirementsFromHtml(
  html: string,
  sourceUrl: string,
): Promise<RequirementExtraction> {
  const body = htmlToText(html);
  if (body.length < 200) {
    throw new Error(
      `not enough readable text at ${sourceUrl} (${body.length} chars) — the call may be a PDF or script-rendered`,
    );
  }
  return extractFromPages([
    { url: sourceUrl, title: htmlTitle(html), text: body.slice(0, 24_000) },
  ]);
}

async function fetchPage(url: string, timeoutMs: number, minChars: number): Promise<FetchedPage> {
  const response = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const body = htmlToText(html);
  if (body.length < minChars) {
    throw new Error(`too little text to be worth adding (${body.length} chars)`);
  }
  return { url, title: htmlTitle(html), text: body, html };
}

/** Fetch several links in parallel; a failed one is dropped, not fatal. */
async function fetchLinks(links: string[], timeoutMs: number, charBudget: number): Promise<Page[]> {
  const fetched = await Promise.allSettled(links.map((link) => fetchPage(link, timeoutMs, 100)));
  return fetched
    .filter(
      (outcome): outcome is PromiseFulfilledResult<FetchedPage> => outcome.status === "fulfilled",
    )
    .map(({ value }) => ({
      url: value.url,
      title: value.title,
      text: value.text.slice(0, charBudget),
    }));
}

/**
 * Read the call's own page, and pages it points to for "How to Apply" or
 * eligibility rules — recursively, in the sense that matters here: a funding
 * notice is frequently a summary that states the offer and defers the actual
 * requirements to a linked page, and reading only the page the catalog
 * happened to store made a real, published requirement look like it was
 * never stated anywhere.
 *
 * Two rounds, not one, and the second only runs when the first gives a
 * concrete reason to look further: no "process" requirement (how to apply)
 * came out of a page that is clearly a real, substantial funding notice. That
 * is exactly the shape of a summary page deferring the mechanics elsewhere,
 * so the second round widens the wording bar for what counts as a link worth
 * following (src/lib/html-text.ts's `broad` option) rather than trying the
 * same narrow search again. Bounded throughout — same site only at every
 * pass, a hard cap on pages per round, two rounds total — this follows a
 * funder's own signposting more persistently, not an open crawl.
 *
 * A failed secondary fetch is not fatal to the whole read: the primary page
 * is what the catalog trusts enough to store, and one broken link on a
 * government site should not turn a real call into a reported failure.
 */
export async function extractRequirementsFromUrl(url: string): Promise<RequirementExtraction> {
  const primary = await fetchPage(url, 30_000, 200).catch((cause: unknown) => {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`could not read ${url}: ${reason} — the call may be a PDF or script-rendered`);
  });
  const pages: Page[] = [
    { url: primary.url, title: primary.title, text: primary.text.slice(0, 16_000) },
  ];
  const read = new Set([url]);

  const firstLinks = relatedLinks(primary.html, url, { limit: 3 });
  pages.push(...(await fetchLinks(firstLinks, 20_000, 8_000)));
  for (const page of pages) read.add(page.url);

  let result = await extractFromPages(pages);

  // The one category most often deferred to a separate page is exactly the
  // one this whole feature exists for — "how to apply" — so its absence,
  // on a page substantial enough to be a real call, is the concrete signal
  // that there is more to find rather than a guess that there might be.
  const foundProcess = result.requirements.some((r) => r.kind === "process");
  const worthDiggingFurther = pages[0]!.text.length > 800;
  if (!foundProcess && worthDiggingFurther) {
    const secondLinks = relatedLinks(primary.html, url, { limit: 3, exclude: read, broad: true });
    const more = await fetchLinks(secondLinks, 20_000, 8_000);
    if (more.length > 0) {
      pages.push(...more);
      result = await extractFromPages(pages);
    }
  }

  return result;
}

/**
 * Read requirements from text we already hold, rather than from a page.
 *
 * This is the path that actually works most of the time, and finding that out
 * cost a round of failed extractions. A Grants.gov detail URL serves a
 * JavaScript shell — fetching it returns a page with no requirements in it at
 * all — while the same opportunity's full description and eligibility prose
 * came down through the API during ingestion and is sitting in our own table.
 * Re-fetching the URL to read text we already have would be slower, more
 * fragile and worse.
 */
export async function extractRequirementsFromText(
  text: string,
  source: string,
  title?: string | null,
): Promise<RequirementExtraction> {
  if (text.trim().length < 200) {
    throw new Error(`not enough text about this call (${text.trim().length} chars) to read`);
  }

  const response = await callLlm({
    role: "extract",
    json: true,
    temperature: 0.1,
    maxTokens: 4000,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          `Source: ${source}`,
          title ? `Call: ${title}` : null,
          "",
          "Call text:",
          text.slice(0, 24_000),
        ]
          .filter((line) => line !== null)
          .join("\n"),
      },
    ],
    validate: (candidate) => {
      try {
        parseRequirements(candidate);
        return true;
      } catch {
        return false;
      }
    },
  });

  return {
    requirements: parseRequirements(response.text),
    readText: text.slice(0, 4000),
    sourcesRead: [source],
    provenance: {
      source,
      title: title ?? null,
      extractedAt: new Date().toISOString(),
      model: `${response.provider}/${response.model}`,
    },
  };
}
