import { z } from "zod";
import { htmlToText, htmlTitle } from "@/lib/html-text";
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

export type RequirementKind = "section" | "eligibility" | "attachment" | "criterion";

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

const KINDS = new Set<RequirementKind>(["section", "eligibility", "attachment", "criterion"]);

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

Record only what the call states. Do not add the sections a proposal "usually"
has — a requirement that is not on this page is a defect, not a helpful default.

For each requirement:
- label: the funder's own heading, as short as it appears (e.g. "Project Description").
- kind: one of
    "section"     — narrative the applicant writes
    "attachment"  — a document to upload (budget, financial statements, letters)
    "eligibility" — a condition the applicant must meet to apply at all
    "criterion"   — something the funder says they will score
- detail: what the call says this must cover, in one or two sentences.
- wordLimit: the stated limit if there is one, otherwise null. Do not invent one.
- evaluationNote: how the funder says this will be assessed, if stated.
- sourceQuote: a short verbatim quote from the page for this requirement. Copy
  it exactly. This is checked against the page.
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
};

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
          `Source: ${sourceUrl}`,
          htmlTitle(html) ? `Page title: ${htmlTitle(html)}` : null,
          "",
          "Call text:",
          body.slice(0, 24_000),
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
    provenance: {
      source: sourceUrl,
      title: htmlTitle(html),
      extractedAt: new Date().toISOString(),
      model: `${response.provider}/${response.model}`,
    },
  };
}

export async function extractRequirementsFromUrl(url: string): Promise<RequirementExtraction> {
  const response = await fetch(url, {
    headers: { "User-Agent": "GrantDesk/1.0 (+reads public funding calls)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`could not read ${url}: HTTP ${response.status}`);
  return extractRequirementsFromHtml(await response.text(), url);
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
    provenance: {
      source,
      title: title ?? null,
      extractedAt: new Date().toISOString(),
      model: `${response.provider}/${response.model}`,
    },
  };
}
