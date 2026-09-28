import type { SourceAdapter, SourceFunder, SourceGrant, SourceHarvest } from "./types";

export type RawCranRecord = {
  BN?: string | null;
  "Legal Name"?: string | null;
  Designation?: string | null;
  City?: string | null;
  Province?: string | null;
  "5050"?: string | number | null;
};

export function parseGivingAmount(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const num = typeof raw === "number" ? raw : parseFloat(String(raw).replace(/[^0-9.-]+/g, ""));
  return Number.isNaN(num) || num <= 0 ? null : Math.round(num);
}

export function formatProvince(prov: string | null | undefined): string {
  if (!prov) return "CA";
  const p = prov.trim().toUpperCase();
  return p.length === 2 ? `CA-${p}` : "CA";
}

export function harvestCranRecords(records: RawCranRecord[]): SourceHarvest {
  const funders: SourceFunder[] = [];
  const grants: SourceGrant[] = [];

  for (const row of records) {
    const name = (row["Legal Name"] ?? "").trim();
    const bn = (row.BN ?? "").trim();
    if (!name || name.length < 3) continue;

    const designation = row.Designation === "A" ? "Public Foundation" : "Private Foundation";
    const jurisdiction = formatProvince(row.Province);
    const giving = parseGivingAmount(row["5050"]);

    funders.push({
      name,
      country: "CA",
      jurisdiction,
      category: `Canadian ${designation}`,
      website: null,
    });

    if (giving && giving >= 10_000) {
      grants.push({
        funderName: name,
        funderCountry: "CA",
        title: `${name} — Philanthropic Giving Program`,
        summary: `${name} is a registered Canadian ${designation} located in ${row.City ?? "Canada"}, ${row.Province ?? ""}. Reports annual grants and gifts to qualified donees of approximately $${giving.toLocaleString("en-US")} CAD (CRA T3010 line 5050).`,
        url: `https://apps.cra-arc.gc.ca/ebci/hacc/srch/pub/dsplyRprtngPryd?q.bn=${bn}`,
        country: "CA",
        currency: "CAD",
        amountMax: giving,
        eligibleApplicantTypes: ["charity", "nonprofit"],
        eligibilityNote: "Registered charities and qualified donees in Canada.",
        language: "en",
        externalId: `cra:${bn || name}`,
      });
    }
  }

  return { funders, grants };
}

export const craFoundations: SourceAdapter = {
  key: "cra-foundations",
  label: "CRA T3010 Canadian Foundations",
  market: "CA",
  cadenceHours: 720,
  description: "CRA T3010 registered public and private foundations granting to qualified donees.",
  async harvest(_options: { limit?: number } = {}): Promise<SourceHarvest> {
    return { funders: [], grants: [] };
  },
};
