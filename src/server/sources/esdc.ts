import type { SourceAdapter, SourceGrant } from "./types";
import { htmlToText, parseAmounts, parseDeadline } from "./ontario-tpon";
import { readTextCapped, safeFetch } from "../safe-fetch";

/**
 * Employment and Social Development Canada — federal grants and contributions
 * for nonprofits, employers, Indigenous organizations and public bodies.
 *
 * ESDC's "Find funding opportunities" page is rendered from one JSON file the
 * department publishes itself. Every entry carries the funder's own status
 * ("Accepting applications" / "Not accepting applications"), the closing-date
 * sentence, the amount sentence and a tagged applicant list. Only entries the
 * department marks open are harvested; the rest drop out and ingestion closes
 * them.
 *
 * Applicant tags are structured data the funder publishes, so they map to
 * canonical types — but only when every tag on the entry maps. A call open to
 * "Employers" or "Unions" as well as nonprofits, mapped partially, would read
 * as closed to anyone outside the mapped part, which the funder never said.
 */

export const ESDC_JSON =
  "https://www.canada.ca/content/dam/esdc-edsc/documents/services/funding/json/funding-en-new.json";
export const ESDC_PAGE =
  "https://www.canada.ca/en/employment-social-development/services/funding/programs.html";
const FUNDER = "Employment and Social Development Canada";

type Tag = { Text?: string; Tag?: string } | null;
export type EsdcEntry = {
  Title?: string;
  Program?: string;
  URL?: string;
  Description?: string;
  FundingAmount?: string;
  Status?: Tag[];
  EndDate?: string;
  ProcessType?: Tag[];
  Applicants?: Tag[];
};

const APPLICANT_TAGS: Record<string, readonly string[]> = {
  "apply-notprofit": ["nonprofit", "charity"],
  "apply-forprofit": ["for-profit", "small-business"],
  // "Municipal, Provincial and Territorial governments, institutions, agencies
  // and Crown Corporations" — public institutions include colleges and
  // universities, so both are named rather than guessing which was meant.
  "apply-govenments": ["government", "academic"],
  "apply-governments": ["government", "academic"],
  "apply-indigenous": ["indigenous"],
  "apply-individuals": ["individual"],
  "apply-selfemployed": ["individual"],
};

export function esdcApplicantTypes(tags: readonly Tag[] | undefined): string[] {
  const out = new Set<string>();
  for (const tag of tags ?? []) {
    if (!tag?.Tag) continue;
    const mapped = APPLICANT_TAGS[tag.Tag];
    if (!mapped) return []; // an unmapped tag makes the whole list incomplete
    for (const type of mapped) out.add(type);
  }
  return [...out].sort();
}

/** "until October 23rd, 2026 at 11:59 pm" — ordinals stripped before the date is read. */
export function esdcDeadline(endDate: string | undefined): string | null {
  if (!endDate?.trim()) return null;
  return parseDeadline(endDate.replace(/(\d{1,2})(?:st|nd|rd|th)\b/g, "$1"));
}

export type EsdcCall = {
  title: string;
  url: string;
  summary: string;
  deadline: string | null;
  deadlineNote: string | null;
  amountMin: number | null;
  amountMax: number | null;
  applicantTypes: string[];
  applicantsText: string | null;
  process: string | null;
};

/** Only what the department itself marks as accepting applications. */
export function parseEsdcFunding(body: unknown): EsdcCall[] {
  const entries = ((body as { Funding?: EsdcEntry[] })?.Funding ?? []).filter(Boolean);
  const calls: EsdcCall[] = [];
  for (const entry of entries) {
    const open = (entry.Status ?? []).some((s) => s?.Tag === "open");
    if (!open || !entry.Title || !entry.URL) continue;
    // "Applicants invited by ESDC" — nobody can apply unsolicited, so it is
    // not a call a consultant can act on.
    const tags = (entry.Applicants ?? []).map((a) => a?.Tag).filter(Boolean);
    if (tags.length > 0 && tags.every((t) => t === "apply-esdc")) continue;
    const url = new URL(entry.URL.trim(), "https://www.canada.ca");
    if (url.hostname !== "www.canada.ca" && url.hostname !== "canada.ca") continue;
    const amountText = entry.FundingAmount?.trim() || null;
    const { min, max } = parseAmounts(amountText ?? "");
    const applicants = (entry.Applicants ?? [])
      .map((a) => a?.Text?.trim())
      .filter((t): t is string => !!t);
    calls.push({
      title: htmlToText(entry.Title),
      url: url.toString(),
      summary: [htmlToText(entry.Description ?? ""), amountText ? `Funding: ${amountText}` : null]
        .filter(Boolean)
        .join("\n\n"),
      deadline: esdcDeadline(entry.EndDate),
      deadlineNote: entry.EndDate?.trim() ? `Accepting applications ${entry.EndDate.trim()}` : null,
      amountMin: min,
      amountMax: max,
      applicantTypes: esdcApplicantTypes(entry.Applicants),
      applicantsText: applicants.length ? applicants.join("; ") : null,
      process: entry.ProcessType?.find((p) => p?.Text)?.Text?.trim() ?? null,
    });
  }
  return calls;
}

/** The funding page's own Eligibility and Contact sections, where it has them. */
export function parseCanadaCaSections(html: string): {
  eligibility: string | null;
  contact: string | null;
} {
  const main = /<main[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html;
  const parts = main.split(/<h2[^>]*>/i).slice(1);
  let eligibility: string | null = null;
  let contact: string | null = null;
  for (const part of parts) {
    const end = part.search(/<\/h2>/i);
    if (end < 0) continue;
    const heading = htmlToText(part.slice(0, end)).toLowerCase();
    const body = htmlToText(part.slice(end + 5))
      .slice(0, 3000)
      .trim();
    if (!body) continue;
    if (!eligibility && /eligib|who can apply/.test(heading)) eligibility = body;
    if (!contact && /contact/.test(heading)) contact = body.slice(0, 800);
  }
  return { eligibility, contact };
}

/*
 * canada.ca sits behind Akamai, which holds the connection open without
 * answering for browser-like user agents that lack a browser's other headers.
 * The runtime's default user agent is answered normally, so none is set.
 */
async function get(url: string): Promise<string> {
  const response = await safeFetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`canada.ca HTTP ${response.status} for ${url}`);
  return readTextCapped(response);
}

export const esdc: SourceAdapter = {
  key: "esdc",
  label: "ESDC funding opportunities",
  market: "CA",
  cadenceHours: 24,
  description:
    "Employment and Social Development Canada grants and contributions currently accepting applications.",

  async harvest({ limit = 100 } = {}) {
    const body: unknown = JSON.parse(await get(ESDC_JSON));
    const all = (body as { Funding?: unknown[] })?.Funding;
    if (!Array.isArray(all) || all.length === 0) {
      throw new Error("ESDC funding JSON has no entries — its format has changed");
    }
    const calls = parseEsdcFunding(body).slice(0, limit);

    const grants: SourceGrant[] = [];
    for (const call of calls) {
      let page: ReturnType<typeof parseCanadaCaSections> = { eligibility: null, contact: null };
      try {
        page = parseCanadaCaSections(await get(call.url));
      } catch {
        // The listing alone still carries status, dates and amounts.
      }
      const applicantLine = call.applicantsText
        ? `ESDC lists these applicant groups: ${call.applicantsText}.`
        : null;
      grants.push({
        funderName: FUNDER,
        funderCountry: "CA",
        title: call.title,
        summary: [call.summary, call.process ? `Process: ${call.process}` : null]
          .filter(Boolean)
          .join("\n\n"),
        url: call.url,
        country: "CA",
        currency: "CAD",
        amountMin: call.amountMin,
        amountMax: call.amountMax,
        deadline: call.deadline,
        deadlineNote: call.deadlineNote,
        language: "en",
        eligibleApplicantTypes: call.applicantTypes,
        eligibilityNote: [applicantLine, page.eligibility].filter(Boolean).join("\n\n") || null,
        status: "open",
        documents: [{ label: "ESDC funding opportunities", url: ESDC_PAGE }],
        contact: page.contact,
        externalId: `esdc:${call.url}`,
      });
    }

    return {
      funders: [
        {
          name: FUNDER,
          country: "CA",
          jurisdiction: "CA-Federal",
          category: "Federal department",
          website: "https://www.canada.ca/en/employment-social-development.html",
        },
      ],
      grants,
    };
  },
};
