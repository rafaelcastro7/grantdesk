import type { SourceAdapter, SourceGrant } from "./types";
import { htmlToText } from "./ontario-tpon";
import { readTextCapped, safeFetch } from "../safe-fetch";
import { todayIn } from "@/lib/deadline";

/**
 * Canada Council for the Arts — the federal arts funder.
 *
 * The council publishes one "Deadlines and notifications" page with a table per
 * program (Explore and Create, Supporting Artistic Practice, …) and a row per
 * grant component, each row naming its own deadlines. Only the "Upcoming
 * deadlines" section is read; the section after it lists past deadlines whose
 * results are still pending, which are not calls anyone can apply to.
 *
 * A row's deadline cell is one of three things, and each maps to a status the
 * council itself stated:
 *   - dated ("8 April 2026 / 22 July 2026 / 25 November 2026") — open until the
 *     next of those dates; a row whose dates have all passed is dropped;
 *   - a season ("Fall 2027", "TBC") — forecasted, with no deadline invented;
 *   - "Any time before the start date of your project" — continuous intake.
 *
 * Applicant eligibility differs per component (artists, groups, organizations)
 * and lives on the council's portal, not this page, so no applicant types are
 * inferred here — the rules engine reports them as unknown.
 */

export const CANADA_COUNCIL_PAGE = "https://canadacouncil.ca/funding/grants/deadlines";
const FUNDER = "Canada Council for the Arts";

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Every "8 April 2026" in a cell, as `YYYY-MM-DD`, in order. */
export function councilDates(text: string): string[] {
  const out: string[] = [];
  for (const hit of text.matchAll(/\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/g)) {
    const month = MONTHS.indexOf(hit[2]!.toLowerCase()) + 1;
    if (month === 0) continue;
    out.push(`${hit[3]}-${String(month).padStart(2, "0")}-${hit[1]!.padStart(2, "0")}`);
  }
  return out;
}

export type CouncilCall = {
  program: string;
  title: string;
  url: string;
  deadlineText: string;
  deadline: string | null;
  status: "open" | "forecasted";
};

export function parseCouncilDeadlines(html: string, today = todayIn()): CouncilCall[] {
  // Only the first h2 section: "Upcoming deadlines".
  const sections = html.split(/<h2[^>]*>/i);
  const upcoming = sections.find((s) => /upcoming deadlines/i.test(s.slice(0, 200))) ?? "";
  const calls: CouncilCall[] = [];
  for (const block of upcoming.split(/<h3[^>]*>/i).slice(1)) {
    const end = block.search(/<\/h3>/i);
    if (end < 0) continue;
    const program = htmlToText(block.slice(0, end)).trim();
    for (const row of block.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = row.match(/<td[\s\S]*?<\/td>/gi);
      if (!cells || cells.length < 2) continue; // the header row uses <th>
      const link = /<a[^>]+href="(https?:[^"]+)"/i.exec(cells[0]!)?.[1];
      const title = htmlToText(cells[0]!).trim();
      const deadlineText = htmlToText(cells[1]!).replace(/\s+/g, " ").trim();
      if (!title || !deadlineText) continue;

      const dates = councilDates(deadlineText);
      let deadline: string | null = null;
      let status: CouncilCall["status"] = "open";
      if (dates.length > 0) {
        deadline = dates.filter((d) => d >= today).sort()[0] ?? null;
        if (!deadline) continue; // every stated date has passed
      } else if (
        /\b(spring|summer|fall|autumn|winter)\s+\d{4}\b|\bTBC\b|\bTBD\b/i.test(deadlineText)
      ) {
        status = "forecasted";
      }
      calls.push({
        program,
        title: `${FUNDER} — ${program}: ${title}`,
        url: link
          ? link.replace(/&amp;/g, "&")
          : `${CANADA_COUNCIL_PAGE}#${encodeURIComponent(title)}`,
        deadlineText,
        deadline,
        status,
      });
    }
  }
  return calls;
}

export const canadaCouncil: SourceAdapter = {
  key: "canada-council",
  label: "Canada Council for the Arts",
  market: "CA",
  cadenceHours: 72,
  description:
    "Canada Council for the Arts grant components with upcoming, forecasted or continuous deadlines.",

  async harvest({ limit = 200 } = {}) {
    const response = await safeFetch(CANADA_COUNCIL_PAGE, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`canadacouncil.ca HTTP ${response.status}`);
    const calls = parseCouncilDeadlines(await readTextCapped(response));
    if (calls.length === 0) {
      throw new Error("Canada Council deadlines page yielded no calls — its format has changed");
    }

    const grants: SourceGrant[] = calls.slice(0, limit).map((call) => ({
      funderName: FUNDER,
      funderCountry: "CA",
      title: call.title,
      summary: `${call.program} program, Canada Council for the Arts. Deadlines: ${call.deadlineText}`,
      url: call.url,
      country: "CA",
      currency: "CAD",
      deadline: call.deadline,
      deadlineNote: call.deadlineText,
      language: "en",
      eligibleApplicantTypes: [],
      status: call.status,
      documents: [{ label: "Deadlines and notifications", url: CANADA_COUNCIL_PAGE }],
      externalId: `canada-council:${call.program}:${call.title}`,
    }));

    return {
      funders: [
        {
          name: FUNDER,
          country: "CA",
          jurisdiction: "CA-Federal",
          category: "Federal Crown corporation",
          website: "https://canadacouncil.ca",
        },
      ],
      grants,
    };
  },
};
