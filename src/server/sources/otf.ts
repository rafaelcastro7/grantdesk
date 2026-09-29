import type { SourceAdapter, SourceGrant } from "./types";
import { htmlToText, parseAmounts, parseDeadline } from "./ontario-tpon";

/**
 * Ontario Trillium Foundation — the province's largest community funder of
 * nonprofits and charities.
 *
 * Two published pages carry everything: the Grant Application Deadlines table
 * (one row per stream, sub-streams under `<h5>`, a "Closed" highlight once an
 * intake has passed) and each stream's own page ("Amount awarded and grant
 * term", eligibility). The table is the source of truth for what exists and
 * when it closes; stream pages add amounts and the eligibility wording.
 */

const BASE = "https://www.otf.ca";
export const OTF_DEADLINES = `${BASE}/our-grants/grant-application-deadlines`;
const FUNDER = "Ontario Trillium Foundation";

export type OtfStream = {
  title: string;
  url: string;
  datesText: string;
  deadline: string | null;
  status: "open" | "closed";
};

function decodeAttr(value: string): string {
  return value.replace(/&amp;/g, "&");
}

/** Status comes from the funder's own "Closed" marker on the final date line. */
function streamFrom(title: string, url: string, cellHtml: string): OtfStream {
  const items = [...cellHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1]!);
  const last = items.at(-1) ?? cellHtml;
  const datesText = htmlToText(cellHtml).replace(/\s*Closed\b/g, " (closed)");
  const deadline = parseDeadline(htmlToText(cellHtml));
  return {
    title,
    url,
    datesText,
    deadline,
    status: /class="highlight"[^>]*>\s*Closed/i.test(last) ? "closed" : "open",
  };
}

export function parseOtfDeadlines(html: string): OtfStream[] {
  const table = /<table[\s\S]*?<\/table>/i.exec(html)?.[0];
  if (!table) return [];
  const streams: OtfStream[] = [];
  for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]!);
    if (cells.length < 2) continue;
    const link = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(cells[0]!);
    if (!link) continue;
    const url = new URL(decodeAttr(link[1]!), BASE).toString();
    const name = htmlToText(link[2]!);
    const cell = cells[1]!;

    // A row holding several programs, each under its own <h5> heading.
    const parts = cell.split(/<h5[^>]*>/i).slice(1);
    if (parts.length > 0) {
      for (const part of parts) {
        const end = part.search(/<\/h5>/i);
        const sub = htmlToText(part.slice(0, end));
        if (/mentor/i.test(sub)) continue; // a volunteer role, not a grant
        streams.push(streamFrom(`${name} — ${sub}`, url, part.slice(end + 5)));
      }
    } else {
      streams.push(streamFrom(`${FUNDER} — ${name}`, url, cell));
    }
  }
  return streams;
}

/** The stream page's amount line, description and eligibility section. */
export function parseOtfStreamPage(html: string): {
  amountMin: number | null;
  amountMax: number | null;
  summary: string | null;
  eligibility: string | null;
} {
  const text = htmlToText(
    html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, ""),
  );
  const amountLine = /Amount awarded[^\n]*\n?([^\n]*\$[^\n]*)/i.exec(text)?.[0] ?? null;
  const { min, max } = parseAmounts(amountLine ?? "");
  const description =
    /<meta[^>]+name="description"[^>]+content="([^"]*)"/i.exec(html)?.[1] ??
    /<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i.exec(html)?.[1] ??
    null;
  // OTF pages have no single "Eligibility" heading; these are the phrases
  // their eligibility sections actually open with.
  const eligibilityStart = text.search(
    /Are you eligible to apply\?|Organization requirements|Eligible applicants|An applicant for an OTF grant must|Who can apply|applicants must be one of the following/i,
  );
  const eligibility =
    eligibilityStart >= 0
      ? text
          .slice(eligibilityStart)
          .split(/\n\s*(?:What we fund|Funding priorities|How to apply|Application support)\b/)[0]!
          .slice(0, 3500)
          .trim()
      : null;
  return {
    amountMin: min,
    amountMax: max,
    summary:
      [description ? htmlToText(description) : null, amountLine?.trim()]
        .filter(Boolean)
        .join("\n\n") || null,
    eligibility,
  };
}

async function get(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (GrantDesk catalog refresh)" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`otf.ca HTTP ${response.status} for ${url}`);
  return response.text();
}

export const otf: SourceAdapter = {
  key: "otf",
  label: FUNDER,
  market: "CA",
  cadenceHours: 24,
  description:
    "Ontario Trillium Foundation grant streams with intake dates, amounts and eligibility.",

  async harvest({ limit = 50 } = {}) {
    const streams = parseOtfDeadlines(await get(OTF_DEADLINES)).slice(0, limit);
    if (streams.length === 0) {
      throw new Error("otf.ca deadlines table parsed to zero streams — its layout has changed");
    }

    const pages = new Map<string, ReturnType<typeof parseOtfStreamPage>>();
    for (const url of new Set(streams.map((s) => s.url))) {
      try {
        pages.set(url, parseOtfStreamPage(await get(url)));
      } catch {
        // A stream page that fails still leaves its dates, which are the part
        // that decides whether it is worth reading at all.
      }
    }

    const grants: SourceGrant[] = streams.map((s) => {
      const page = pages.get(s.url);
      return {
        funderName: FUNDER,
        funderCountry: "CA",
        title: s.title,
        summary: [page?.summary, `Intake: ${s.datesText}`].filter(Boolean).join("\n\n"),
        url: s.url,
        country: "CA",
        currency: "CAD",
        amountMin: page?.amountMin ?? null,
        amountMax: page?.amountMax ?? null,
        deadline: s.deadline,
        language: "en",
        eligibilityNote: page?.eligibility ?? null,
        status: s.status,
        documents: [{ label: "Grant application deadlines", url: OTF_DEADLINES }],
        contact: "OTF Program Managers — https://www.otf.ca/support/contact-our-team",
        externalId: `otf:${s.title}`,
      };
    });

    return {
      funders: [
        {
          name: FUNDER,
          country: "CA",
          jurisdiction: "CA-ON",
          category: "Provincial foundation (agency of the Government of Ontario)",
          website: BASE,
        },
      ],
      grants,
    };
  },
};
