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
const PAGE_SIZE = 500;

type OppHit = {
  id?: string;
  number?: string;
  title?: string;
  agency?: string;
  agencyCode?: string;
  closeDate?: string;
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

    const usable = hits.filter((h) => h.title && h.agency).slice(0, limit);

    const funders = new Map<string, SourceFunder>();
    const grants: SourceGrant[] = [];

    for (const hit of usable) {
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
        url: hit.id
          ? `https://www.grants.gov/search-results-detail/${hit.id}`
          : "https://www.grants.gov",
        country: "US",
        currency: "USD",
        deadline: parseCloseDate(hit.closeDate),
        language: "en",
        externalId: `grants-gov:${hit.number || hit.id}`,
      });
    }

    return { funders: [...funders.values()], grants };
  },
};
