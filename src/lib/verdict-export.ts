import { toCsv } from "./csv";

export type Verdict = "eligible" | "needs_input" | "ineligible";

/**
 * "Eligible" splits in two. When the funder publishes who may apply and this
 * client is on the list, that is a verified yes. When it publishes no list,
 * location and dates pass but nobody has checked the applicant rules —
 * showing both under one "Can apply" claimed verification that never happened.
 */
export type GroupKey = Verdict | "unverified";

export function groupOf(row: {
  verdict: Verdict;
  eligibility_checks: Array<{ rule_key: string; status: string }>;
}): GroupKey {
  if (row.verdict !== "eligible") return row.verdict;
  const applicant = row.eligibility_checks.find((c) => c.rule_key === "applicant_type");
  return applicant?.status === "pass" ? "eligible" : "unverified";
}

export const GROUP_EXPORT_LABEL: Record<GroupKey, string> = {
  eligible: "verified",
  unverified: "unverified",
  needs_input: "needs input",
  ineligible: "ruled out",
};

const GROUP_ORDER: GroupKey[] = ["eligible", "unverified", "needs_input", "ineligible"];

/** Rule columns in the order the rules run; anything newer follows, sorted. */
const RULE_ORDER = [
  "jurisdiction",
  "deadline",
  "role",
  "applicant_type",
  "scale",
  "cost_share",
  "runway",
  "strategic_fit",
];

export type VerdictExportRow = {
  verdict: Verdict;
  retrieval: { terms?: string[] } | null;
  grants: {
    title: string;
    country: string;
    currency: string | null;
    amount_min: number | null;
    amount_max: number | null;
    deadline: string | null;
    funders: { name: string } | null;
  } | null;
  eligibility_checks: Array<{ rule_key: string; status: string; detail: string }>;
};

/**
 * Every match, including the ruled-out ones: the export is the record of what
 * was considered, and a spreadsheet without the rejections reads as "nothing
 * else was looked at". A rule that did not run for a call is left blank — it
 * was not checked, which is different from "unknown".
 */
export function verdictsCsv(rows: ReadonlyArray<VerdictExportRow>): string {
  const present = new Set(rows.flatMap((r) => r.eligibility_checks.map((c) => c.rule_key)));
  const rules = [
    ...RULE_ORDER.filter((k) => present.has(k)),
    ...[...present].filter((k) => !RULE_ORDER.includes(k)).sort(),
  ];
  const header = [
    "Title",
    "Funder",
    "Country",
    "Deadline",
    "Amount min",
    "Amount max",
    "Currency",
    "Group",
    ...rules.flatMap((k) => [`${k} status`, `${k} detail`]),
    "Matched terms",
  ];
  const sorted = rows
    .map((row, index) => ({ row, index, group: groupOf(row) }))
    .sort(
      (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.index - b.index,
    );
  const body = sorted.map(({ row, group }) => {
    const g = row.grants;
    const byRule = new Map(row.eligibility_checks.map((c) => [c.rule_key, c]));
    return [
      g?.title,
      g?.funders?.name,
      g?.country,
      g?.deadline,
      g?.amount_min,
      g?.amount_max,
      g?.currency,
      GROUP_EXPORT_LABEL[group],
      ...rules.flatMap((k) => [byRule.get(k)?.status, byRule.get(k)?.detail]),
      (row.retrieval?.terms ?? []).join("; "),
    ];
  });
  return toCsv([header, ...body]);
}
