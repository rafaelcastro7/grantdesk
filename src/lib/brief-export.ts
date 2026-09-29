import { formatMoney } from "./money";

/**
 * The Opportunity Brief as a client-facing document: the same content feeds
 * the printed page and the Markdown download, so the two cannot disagree.
 *
 * Empty fields are written as "Not stated" rather than dropped — a missing
 * match requirement on paper reads as "no match required".
 */

export type BriefCall = {
  title: string;
  funder: string | null;
  country: string | null;
  deadline: string | null;
  amountMin: number | null;
  amountMax: number | null;
  currency: string | null;
  url: string | null;
  opportunityNumber?: string | null;
};

export type BriefFields = {
  role: "lead" | "funded_partner" | "other" | null;
  role_other: string | null;
  intake: "fixed" | "rolling" | null;
  application_structure: "one_stage" | "two_stage" | null;
  strategic_angle: string | null;
  mandatory_components: string | null;
  request_amount: number | null;
  net_revenue: number | null;
  match_required: number | null;
  in_kind_cap: number | null;
  cash_match_confirmed: boolean;
  risks: string | null;
  recommendation: "go" | "no_go" | "go_conditional" | null;
  recommendation_reason: string | null;
  condition: string | null;
  decision: "pending" | "go" | "no_go" | "go_conditional";
  condition_met: boolean;
  decided_by: string | null;
  decision_reason: string | null;
  decided_at: string | null;
  recorderEmail: string | null;
};

export type BriefDocument = {
  title: string;
  /** False when the brief shown was pre-filled and never saved. */
  saved: boolean;
  sections: Array<{ heading: string; rows: Array<[label: string, value: string]> }>;
};

const NOT_STATED = "Not stated";

const ROLE = { lead: "Lead applicant", funded_partner: "Funded partner", other: "Other" };
const INTAKE = { fixed: "Fixed deadline", rolling: "Rolling" };
const STRUCTURE = { one_stage: "One-stage", two_stage: "Two-stage (EOI first)" };
const RECOMMENDATION = { go: "Go", no_go: "No-go", go_conditional: "Go-conditional" };
const DECISION = {
  pending: "Pending — awaiting leadership decision",
  go: "GO",
  no_go: "NO-GO",
  go_conditional: "GO-CONDITIONAL",
};

function text(value: string | null | undefined): string {
  return value?.trim() ? value.trim() : NOT_STATED;
}

function money(value: number | null, currency: string | null): string {
  return value == null ? NOT_STATED : formatMoney(value, currency);
}

function awardRange(call: BriefCall): string {
  const { amountMin: min, amountMax: max, currency } = call;
  if (min != null && max != null && min !== max) {
    return `${formatMoney(min, currency)} – ${formatMoney(max, currency)}`;
  }
  if (max != null) return `Up to ${formatMoney(max, currency)}`;
  if (min != null) return `From ${formatMoney(min, currency)}`;
  return "Not published by the funder";
}

export function briefDocument(call: BriefCall, brief: BriefFields, saved: boolean): BriefDocument {
  const role =
    brief.role === "other" && brief.role_other?.trim()
      ? `Other — ${brief.role_other.trim()}`
      : brief.role
        ? ROLE[brief.role]
        : NOT_STATED;
  const facts: Array<[string, string]> = [
    ["Funder", text(call.funder)],
    ["Country", text(call.country)],
    ["Deadline", call.deadline ?? "No closing date published"],
    ["Award", awardRange(call)],
  ];
  if (call.opportunityNumber) facts.push(["Opportunity number", call.opportunityNumber]);
  if (call.url) facts.push(["Source", call.url]);

  const decision: Array<[string, string]> = [
    ["Decision", DECISION[brief.decision]],
    ["Approved by", text(brief.decided_by)],
    ["Decision reason", text(brief.decision_reason)],
    ["Decided on", brief.decided_at ? brief.decided_at.slice(0, 10) : NOT_STATED],
  ];
  if (brief.recorderEmail) decision.push(["Recorded by", brief.recorderEmail]);
  if (brief.decision === "go_conditional") {
    decision.push(["Condition met", brief.condition_met ? "Yes" : "Not yet"]);
  }

  return {
    title: call.title,
    saved,
    sections: [
      { heading: "The call", rows: facts },
      {
        heading: "Brief",
        rows: [
          ["Role", role],
          ["Intake", brief.intake ? INTAKE[brief.intake] : NOT_STATED],
          [
            "Application structure",
            brief.application_structure ? STRUCTURE[brief.application_structure] : NOT_STATED,
          ],
          ["Strategic angle", text(brief.strategic_angle)],
          ["Mandatory components", text(brief.mandatory_components)],
          ["Request amount", money(brief.request_amount, call.currency)],
          ["Net revenue", money(brief.net_revenue, call.currency)],
          ["Match required", money(brief.match_required, call.currency)],
          ["In-kind cap", money(brief.in_kind_cap, call.currency)],
          ["Cash match confirmed", brief.cash_match_confirmed ? "Yes" : "No"],
          ["Risks and unknowns", text(brief.risks)],
          [
            "Recommendation",
            brief.recommendation ? RECOMMENDATION[brief.recommendation] : NOT_STATED,
          ],
          ["Recommendation reason", text(brief.recommendation_reason)],
          ["Condition", text(brief.condition)],
        ],
      },
      { heading: "Decision record", rows: decision },
    ],
  };
}

export function briefMarkdown(doc: BriefDocument): string {
  const lines = [`# Opportunity Brief — ${doc.title}`, ""];
  if (!doc.saved) lines.push("_Draft: pre-filled from the call and not yet saved._", "");
  for (const section of doc.sections) {
    lines.push(`## ${section.heading}`, "");
    for (const [label, value] of section.rows) {
      // Multi-line answers (component lists, risks) stay readable as a block.
      if (value.includes("\n")) {
        lines.push(`**${label}:**`, "", value, "");
      } else {
        lines.push(`- **${label}:** ${value}`);
      }
    }
    lines.push("");
  }
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

export function briefFilename(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `opportunity-brief-${slug || "call"}.md`;
}
