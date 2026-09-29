import { formatMoney } from "./money";

export type FundedBy = "grant" | "cash_match" | "in_kind";

export type BudgetLine = {
  category: string;
  description?: string | null;
  hours: number | null;
  rate: number | null;
  amount: number | null;
  funded_by: FundedBy;
};

export type BudgetTotals = {
  request: number;
  cashMatch: number;
  inKind: number;
  match: number;
  totalCost: number;
  /** Match as a share of total cost, 0–100; null when there is no cost yet. */
  matchPercent: number | null;
  /** In-kind as a share of the match, 0–100; null when there is no match. */
  inKindShareOfMatch: number | null;
};

/** A flat amount wins over hours × rate: it is what the consultant typed last. */
export function lineCost(line: BudgetLine): number {
  if (line.amount !== null) return line.amount;
  if (line.hours !== null && line.rate !== null) return line.hours * line.rate;
  return 0;
}

export function computeBudget(lines: readonly BudgetLine[]): BudgetTotals {
  let request = 0;
  let cashMatch = 0;
  let inKind = 0;
  for (const line of lines) {
    const cost = lineCost(line);
    if (line.funded_by === "grant") request += cost;
    else if (line.funded_by === "cash_match") cashMatch += cost;
    else inKind += cost;
  }
  const match = cashMatch + inKind;
  const totalCost = request + match;
  return {
    request,
    cashMatch,
    inKind,
    match,
    totalCost,
    matchPercent: totalCost > 0 ? (match / totalCost) * 100 : null,
    inKindShareOfMatch: match > 0 ? (inKind / match) * 100 : null,
  };
}

export type BudgetRules = {
  currency: string | null;
  amountMin: number | null;
  amountMax: number | null;
  /** Applicant's required share of total cost, from detectCostSharePercent. */
  costSharePercent: number | null;
  /** Most of the match that may be in kind, from detectInKindCapPercent. */
  inKindCapPercent: number | null;
};

export type BudgetFinding = { level: "violation" | "unknown"; text: string };

const pct = (value: number) => `${Math.round(value * 10) / 10}%`;

/**
 * Where the budget breaks what the call published. A rule the funder did not
 * state is reported as unchecked, never as met: silence is not permission.
 */
export function checkBudget(totals: BudgetTotals, rules: BudgetRules): BudgetFinding[] {
  const money = (n: number) => formatMoney(n, rules.currency);
  const findings: BudgetFinding[] = [];
  if (totals.totalCost === 0) return findings;

  if (rules.amountMax !== null && totals.request > rules.amountMax) {
    findings.push({
      level: "violation",
      text: `The request of ${money(totals.request)} is above the most this call awards (${money(rules.amountMax)}).`,
    });
  }
  if (rules.amountMin !== null && totals.request < rules.amountMin) {
    findings.push({
      level: "violation",
      text: `The request of ${money(totals.request)} is below the smallest award this call makes (${money(rules.amountMin)}).`,
    });
  }
  if (rules.amountMin === null && rules.amountMax === null) {
    findings.push({
      level: "unknown",
      text: "The call publishes no award range, so the request could not be checked against one.",
    });
  }

  if (rules.costSharePercent !== null) {
    const required = (rules.costSharePercent / 100) * totals.totalCost;
    if (totals.matchPercent !== null && totals.matchPercent + 1e-9 < rules.costSharePercent) {
      findings.push({
        level: "violation",
        text: `The call expects the applicant to carry ${pct(rules.costSharePercent)} of total cost; this budget matches ${pct(totals.matchPercent)} (${money(totals.match)} of ${money(totals.totalCost)}, about ${money(required - totals.match)} short).`,
      });
    }
  } else {
    findings.push({
      level: "unknown",
      text: "No cost-share percentage was found in the call's text; confirm the match rule with the funder.",
    });
  }

  if (rules.inKindCapPercent !== null) {
    if (
      totals.inKindShareOfMatch !== null &&
      totals.inKindShareOfMatch - 1e-9 > rules.inKindCapPercent
    ) {
      const allowed = (rules.inKindCapPercent / 100) * totals.match;
      findings.push({
        level: "violation",
        text: `In-kind is ${pct(totals.inKindShareOfMatch)} of the match; the call caps it at ${pct(rules.inKindCapPercent)} (at most ${money(allowed)} of ${money(totals.match)}).`,
      });
    }
  } else if (totals.inKind > 0) {
    findings.push({
      level: "unknown",
      text: "The budget counts in-kind contributions, and the call's text states no in-kind cap; confirm in-kind is accepted.",
    });
  }

  return findings;
}
