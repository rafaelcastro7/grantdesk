import { fromGrantsGovCodes } from "@/lib/applicant-types";
import { htmlToText } from "@/lib/html-text";
import type { SourceAdapter, SourceFunder, SourceGrant } from "./types";

/**
 * US federal opportunities from the public Grants.gov Search2 API.
 *
 * One record per opportunity, attributed to its issuing agency. The
 * predecessor derived only *funders* from this endpoint and dropped the
 * opportunities themselves, which left every US agency in the directory with
 * nothing search could reach.
 */

const SEARCH2_URL = "https://api.grants.gov/v1/api/search2";
const FETCH_URL = "https://api.grants.gov/v1/api/fetchOpportunity";
const PAGE_SIZE = 500;
/**
 * Search2 returns titles and dates only. Everything matching actually needs —
 * the description that lexical and vector retrieval read, the award range, and
 * the structured applicant types the eligibility gate decides on — lives one
 * request deeper. Details are therefore fetched per opportunity, bounded by
 * this many in flight so a full run does not hammer a public API.
 */
const DETAIL_CONCURRENCY = 8;

type OppHit = {
  id?: string;
  number?: string;
  title?: string;
  agency?: string;
  agencyCode?: string;
  closeDate?: string;
  /** "posted" or "forecasted". A forecast is not accepting applications yet. */
  oppStatus?: string;
  /** Assistance Listing (formerly CFDA) numbers — the key prior awards are indexed under. */
  cfdaList?: string[];
};

/** Grants.gov returns US-format dates; anything else becomes null, not a guess. */
export function parseCloseDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const hit = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!hit) return null;
  const [, month, day, year] = hit;
  return `${year}-${month}-${day}`;
}

/** Agency codes are dotted hierarchies (HHS-NIH11); the first segment is the department. */
export function departmentOf(agencyCode: string | undefined | null): string {
  const first = (agencyCode ?? "").split("-")[0];
  return first ? `US-${first}` : "US-Federal";
}

async function fetchPage(startRecordNum: number) {
  const response = await fetch(SEARCH2_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rows: PAGE_SIZE,
      startRecordNum,
      keyword: "",
      oppStatuses: "forecasted|posted",
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`grants.gov HTTP ${response.status}`);
  const body = (await response.json()) as {
    errorcode?: number;
    data?: { oppHits?: OppHit[]; hitCount?: number };
  };
  if (body.errorcode !== 0) throw new Error(`grants.gov error code ${body.errorcode}`);
  return { hits: body.data?.oppHits ?? [], hitCount: body.data?.hitCount ?? 0 };
}

export type OppDetail = {
  summary: string | null;
  eligibilityNote: string | null;
  eligibleApplicantTypes: string[];
  amountMin: number | null;
  amountMax: number | null;
  contact: string | null;
  costSharingRequired: boolean | null;
  documents: Array<{ label: string; url: string }>;
  deadlineNote: string | null;
  /** A forecast's estimated application date, `YYYY-MM-DD`. */
  estimatedDeadline: string | null;
};

const ATTACHMENT_URL = "https://apply07.grants.gov/grantsws/rest/opportunity/att/download/";

const MONTHS: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

/** "Nov 25, 2025 12:00:00 AM EST" → "2025-11-25"; anything else → null. */
export function parseDetailDate(raw: unknown): string | null {
  const hit = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/.exec(String(raw ?? "").trim());
  if (!hit || !MONTHS[hit[1]!]) return null;
  return `${hit[3]}-${MONTHS[hit[1]!]}-${hit[2]!.padStart(2, "0")}`;
}

/** Award figures arrive as strings, and "none" is a real value in this feed. */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value > 0 ? value : null;
}

export function readDetail(body: unknown): OppDetail {
  // Posted opportunities carry a `synopsis`; forecasted ones carry a `forecast`
  // with the same fields under a different description key. Reading only the
  // first silently dropped the description and applicant list for every
  // forecasted call — a third of the feed, and precisely the third a consultant
  // most wants early warning of.
  const data = (body as { data?: Record<string, unknown> })?.data ?? {};
  const detail = ((data.synopsis ?? data.forecast ?? {}) as Record<string, unknown>) || {};
  const applicantTypes = (detail.applicantTypes ?? []) as Array<{ id?: string }>;
  const description = detail.synopsisDesc ?? detail.forecastDesc ?? "";

  return {
    // The description is HTML in this feed; the tsvector and the embedding both
    // want prose, and a consultant reading the card wants it even more.
    summary: htmlToText(String(description)).slice(0, 4000) || null,
    eligibilityNote:
      htmlToText(String(detail.applicantEligibilityDesc ?? "")).slice(0, 2000) || null,
    eligibleApplicantTypes: fromGrantsGovCodes(
      applicantTypes.map((t) => String(t?.id ?? "")).filter(Boolean),
    ),
    amountMin: parseAmount(detail.awardFloor),
    amountMax: parseAmount(detail.awardCeiling),
    contact:
      [detail.agencyContactName, detail.agencyContactEmail, detail.agencyContactPhone]
        .map((part) =>
          String(part ?? "")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean)
        .join(" · ") || null,
    costSharingRequired: typeof detail.costSharing === "boolean" ? detail.costSharing : null,
    // The NOFO itself: the one document the application is written against.
    documents: (
      (data.synopsisAttachmentFolders ?? []) as Array<{
        synopsisAttachments?: Array<{ id?: number | string; fileName?: string }>;
      }>
    )
      .flatMap((folder) => folder.synopsisAttachments ?? [])
      .filter((file) => file.id != null)
      .map((file) => ({
        label: String(file.fileName ?? `Attachment ${file.id}`),
        url: `${ATTACHMENT_URL}${file.id}`,
      })),
    deadlineNote: htmlToText(String(detail.responseDateDesc ?? "")).slice(0, 1000) || null,
    estimatedDeadline: parseDetailDate(detail.estApplicationResponseDate),
  };
}

const EMPTY_DETAIL: OppDetail = {
  summary: null,
  eligibilityNote: null,
  eligibleApplicantTypes: [],
  amountMin: null,
  amountMax: null,
  contact: null,
  costSharingRequired: null,
  documents: [],
  deadlineNote: null,
  estimatedDeadline: null,
};

async function fetchDetail(opportunityId: string): Promise<OppDetail> {
  try {
    const response = await fetch(FETCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opportunityId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return EMPTY_DETAIL;
    return readDetail(await response.json());
  } catch {
    // One unreadable detail must not lose the opportunity itself. The grant
    // still lands with its title and deadline, and its applicant list stays
    // empty — which the rules engine reports as unverified rather than open.
    return EMPTY_DETAIL;
  }
}

/** Bounded fan-out: a worker pool, so a 2000-opportunity run stays polite. */
async function fetchDetails(ids: string[]): Promise<Map<string, OppDetail>> {
  const out = new Map<string, OppDetail>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(DETAIL_CONCURRENCY, ids.length) }, async () => {
      for (let i = next++; i < ids.length; i = next++) {
        const id = ids[i];
        if (id) out.set(id, await fetchDetail(id));
      }
    }),
  );
  return out;
}

export const grantsGov: SourceAdapter = {
  key: "grants-gov",
  label: "Grants.gov",
  market: "US",
  cadenceHours: 24,
  description: "Open and forecasted US federal funding opportunities, by issuing agency.",

  async harvest({ limit = 2000 } = {}) {
    const hits: OppHit[] = [];
    let start = 0;
    let hitCount = Infinity;

    while (hits.length < limit && start < hitCount) {
      const page = await fetchPage(start);
      hitCount = page.hitCount;
      if (page.hits.length === 0) break;
      hits.push(...page.hits);
      start += page.hits.length;
    }

    const usable = hits.filter((h) => h.title && h.agency && h.id).slice(0, limit);
    const details = await fetchDetails(usable.map((h) => h.id!));

    const funders = new Map<string, SourceFunder>();
    const grants: SourceGrant[] = [];

    for (const hit of usable) {
      const detail = details.get(hit.id!) ?? EMPTY_DETAIL;
      const name = hit.agency!;
      if (!funders.has(name)) {
        funders.set(name, {
          name,
          country: "US",
          jurisdiction: departmentOf(hit.agencyCode),
          category: "US federal agency",
          website: hit.agencyCode
            ? `https://www.grants.gov/search-grants?agencies=${encodeURIComponent(hit.agencyCode)}`
            : "https://www.grants.gov",
        });
      }

      grants.push({
        funderName: name,
        funderCountry: "US",
        title: hit.title!.slice(0, 500),
        summary: detail.summary,
        url: `https://www.grants.gov/search-results-detail/${hit.id}`,
        country: "US",
        currency: "USD",
        amountMin: detail.amountMin,
        amountMax: detail.amountMax,
        deadline: parseCloseDate(hit.closeDate),
        language: "en",
        eligibleApplicantTypes: detail.eligibleApplicantTypes,
        eligibilityNote: detail.eligibilityNote,
        status: hit.oppStatus === "forecasted" ? "forecasted" : "open",
        estimatedDeadline: detail.estimatedDeadline,
        costSharingRequired: detail.costSharingRequired,
        deadlineNote: detail.deadlineNote,
        opportunityNumber: hit.number ?? null,
        contact: detail.contact,
        documents: detail.documents,
        assistanceListings: (hit.cfdaList ?? []).map((code) => String(code).trim()).filter(Boolean),
        externalId: `grants-gov:${hit.number || hit.id}`,
      });
    }

    return { funders: [...funders.values()], grants };
  },
};
