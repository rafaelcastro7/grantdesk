import type { SourceAdapter, SourceFunder, SourceGrant } from "./types";

/**
 * Canadian programs from Innovation Canada's Business Benefits Finder, via
 * open.canada.ca's CKAN API.
 *
 * The workbook has one row per *program*, with bilingual titles and real
 * descriptions — which is exactly what a consultant needs and what the
 * predecessor discarded, keeping only five sample titles per organization.
 *
 * Note the honest limitation: the workbook carries no per-program URL, only
 * the administering organization's page. That is recorded as-is rather than
 * fabricated, and it is why enrichment against these URLs sometimes 404s.
 */

const PACKAGE_URL =
  "https://open.canada.ca/data/api/3/action/package_show?id=4e75337e-70d0-4ed7-92d1-3b85192ec6b1";

type CkanResource = { url?: string; format?: string; name?: string; last_modified?: string | null };

/**
 * Several older resources have `last_modified: null` and only a human-readable
 * name like "IC Programs and Services (2022 September)". Comparing that string
 * against an ISO timestamp is meaningless — 'I' sorts after '2' — so a
 * three-year-stale workbook can win. Parse a real date out of either field.
 */
export function resourceTimestamp(resource: CkanResource): number {
  if (resource.last_modified) {
    const parsed = Date.parse(resource.last_modified);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const match = /\((\d{4})\s+([A-Za-z]+)\)/.exec(resource.name ?? "");
  if (match) {
    const parsed = Date.parse(`${match[2]} 1, ${match[1]}`);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/** Government prefixes encode the province; strip them for the display name. */
export function organizationName(raw: string): string {
  return raw
    .trim()
    .replace(
      /^(?:government of (?:canada|alberta|british columbia|manitoba|new brunswick|newfoundland and labrador|nova scotia|ontario|prince edward island|quebec|saskatchewan)|gouvernement du canada|gouvernement de l['’]ontario|gouvernement du qu[ée]bec),\s*/i,
      "",
    );
}

export function jurisdictionOf(raw: string): string {
  const table: Array<[RegExp, string]> = [
    [/government of canada|gouvernement du canada/i, "CA-Federal"],
    [/government of ontario|gouvernement de l['’]ontario/i, "CA-ON"],
    [/government of quebec|gouvernement du qu[ée]bec/i, "CA-QC"],
    [/government of alberta/i, "CA-AB"],
    [/government of british columbia/i, "CA-BC"],
    [/government of manitoba/i, "CA-MB"],
    [/government of saskatchewan/i, "CA-SK"],
    [/government of nova scotia/i, "CA-NS"],
    [/government of new brunswick/i, "CA-NB"],
    [/government of newfoundland and labrador/i, "CA-NL"],
    [/government of prince edward island/i, "CA-PE"],
  ];
  for (const [pattern, code] of table) if (pattern.test(raw)) return code;
  return "CA";
}

async function findLatestWorkbook(): Promise<string> {
  const response = await fetch(PACKAGE_URL, { signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`open.canada.ca HTTP ${response.status}`);
  const payload = (await response.json()) as {
    success?: boolean;
    result?: { resources?: CkanResource[] };
  };
  if (payload.success !== true) throw new Error("open.canada.ca returned an invalid package");

  const workbooks = (payload.result?.resources ?? []).filter(
    (r) => r.url && /xlsx/i.test(r.format ?? ""),
  );
  const latest = workbooks.sort((a, b) => resourceTimestamp(a) - resourceTimestamp(b)).at(-1);
  if (!latest?.url) throw new Error("no XLSX resource in the Business Benefits Finder package");
  return latest.url;
}

export const businessBenefitsFinder: SourceAdapter = {
  key: "business-benefits-finder",
  label: "Innovation Canada",
  market: "CA",
  cadenceHours: 24 * 7,
  description: "Canadian federal and provincial business support programs, with descriptions.",

  async harvest({ limit = 5000 } = {}) {
    const workbookUrl = await findLatestWorkbook();
    const response = await fetch(workbookUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`workbook HTTP ${response.status}`);

    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await response.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 3) throw new Error("workbook has no usable sheet");

    const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? "").toLowerCase());
    const indexOf = (pattern: RegExp) => header.findIndex((v) => pattern.test(v));
    const columns = {
      title: indexOf(/^title\s*-\s*english$/),
      longEn: indexOf(/^long description\s*-\s*english$/),
      shortEn: indexOf(/^short description\s*-\s*english$/),
      org: indexOf(/^organization\s*-\s*english$/),
      url: indexOf(/^organization url\s*-\s*english$/),
    };
    if (columns.title < 1 || columns.org < 1 || columns.url < 1) {
      throw new Error("workbook is missing the expected columns");
    }

    const cell = (values: unknown[], index: number) => {
      const value = values[index];
      if (value == null) return "";
      if (typeof value === "object" && "text" in value) {
        return String((value as { text?: unknown }).text ?? "").trim();
      }
      return String(value).trim();
    };

    const funders = new Map<string, SourceFunder>();
    const grants: SourceGrant[] = [];

    for (let rowNumber = 3; rowNumber <= sheet.rowCount && grants.length < limit; rowNumber++) {
      const values = sheet.getRow(rowNumber).values as unknown[];
      const title = cell(values, columns.title);
      const rawOrg = cell(values, columns.org);
      const url = cell(values, columns.url);
      const org = organizationName(rawOrg);
      if (title.length < 3 || org.length < 3 || !url.startsWith("http")) continue;

      if (!funders.has(org)) {
        funders.set(org, {
          name: org,
          country: "CA",
          jurisdiction: jurisdictionOf(rawOrg),
          category: "Canadian program administrator",
          website: url,
        });
      }

      grants.push({
        funderName: org,
        funderCountry: "CA",
        title: title.slice(0, 500),
        summary: (cell(values, columns.longEn) || cell(values, columns.shortEn)).slice(0, 4000),
        url,
        country: "CA",
        currency: "CAD",
        language: "en",
        externalId: `bbf:${org}:${title}`,
      });
    }

    return { funders: [...funders.values()], grants };
  },
};
