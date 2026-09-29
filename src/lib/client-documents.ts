/**
 * Whether a document in a client's register can still be sent.
 *
 * Funders reject stale paperwork on rules they rarely publish per call, so
 * these defaults are the common ones: financial statements older than 18
 * months, an insurance certificate older than a year. An `expires_on` the
 * consultant typed always wins over a default — it is read off the document.
 */

export const DOCUMENT_KINDS = [
  "audited_financials",
  "financial_statements",
  "board_list",
  "incorporation",
  "charity_registration",
  "insurance_certificate",
  "letter_of_support",
  "budget",
  "annual_report",
  "other",
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const KIND_LABEL: Record<DocumentKind, string> = {
  audited_financials: "Audited financial statements",
  financial_statements: "Financial statements",
  board_list: "Board list",
  incorporation: "Incorporation certificate",
  charity_registration: "Charity registration",
  insurance_certificate: "Insurance certificate",
  letter_of_support: "Letter of support",
  budget: "Budget",
  annual_report: "Annual report",
  other: "Other",
};

/**
 * Months after issue before a document is treated as stale. Null means it
 * does not go stale by age (an incorporation certificate stays true).
 */
export const VALIDITY_MONTHS: Record<DocumentKind, number | null> = {
  audited_financials: 18,
  financial_statements: 18,
  annual_report: 18,
  insurance_certificate: 12,
  board_list: 12,
  letter_of_support: 12,
  budget: 12,
  incorporation: null,
  charity_registration: null,
  other: null,
};

export const EXPIRING_WITHIN_DAYS = 60;

export type DocumentStatus = "current" | "expiring" | "expired" | "undated";

export type DatedDocument = {
  kind: DocumentKind;
  issued_on: string | null;
  expires_on: string | null;
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function addMonths(isoDate: string, months: number): string | null {
  const match = ISO_DATE.exec(isoDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1 + months;
  const day = Number(match[3]);
  // Clamped to the target month's last day, so 31 Aug + 18 months is 28/29 Feb
  // rather than rolling into March.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

/** The last day the document can be sent, or null when nothing dates it. */
export function effectiveExpiry(doc: DatedDocument): string | null {
  if (doc.expires_on) return doc.expires_on;
  const months = VALIDITY_MONTHS[doc.kind];
  if (!doc.issued_on || months === null) return null;
  return addMonths(doc.issued_on, months);
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function documentStatus(doc: DatedDocument, today: Date): DocumentStatus {
  const expiry = effectiveExpiry(doc);
  if (!expiry) {
    // Issued and of a kind that does not age: current. A kind that ages but
    // has no date at all cannot be judged, and saying "current" would claim a
    // check we did not make.
    return doc.issued_on && VALIDITY_MONTHS[doc.kind] === null ? "current" : "undated";
  }
  const todayIso = toIsoDate(today);
  if (expiry < todayIso) return "expired";
  const soon = toIsoDate(new Date(today.getTime() + EXPIRING_WITHIN_DAYS * 86_400_000));
  return expiry <= soon ? "expiring" : "current";
}
