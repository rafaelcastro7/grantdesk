import type { RuleResult } from "./eligibility";

/**
 * Group the rule checks already computed for a match into named categories,
 * so a consultant reading forty results can tell *what kind* of thing is
 * wrong without opening every check.
 *
 * This is deliberately not a score. The predecessor's own tooling learned to
 * show a breakdown across axes instead of one number — the incumbent's
 * failure mode is exactly the reverse, a single "match %" with nothing
 * behind it its own users describe re-verifying by hand. But bringing that
 * *number* over would reintroduce the thing this system exists to avoid:
 * blending a hard eligibility fact with a soft budget-fit guess into one
 * figure hides which half is which. So each axis keeps the same three-state
 * vocabulary as the rules underneath it — pass, fail, unknown, or partial
 * when a category's checks disagree — and every reason is the literal
 * sentence a check already produced. Nothing here is inferred; it is sorted.
 */

export type AxisKey = "eligibility" | "timeline" | "budget" | "fit";

export type AxisStatus = "pass" | "partial" | "fail" | "unknown";

export type Axis = {
  key: AxisKey;
  label: string;
  status: AxisStatus;
  /** True when a hard gate inside this axis is what decided the verdict. */
  decisive: boolean;
  reasons: string[];
};

const AXIS_OF: Record<string, AxisKey> = {
  jurisdiction: "eligibility",
  applicant_type: "eligibility",
  role: "eligibility",
  deadline: "timeline",
  runway: "timeline",
  scale: "budget",
  cost_share: "budget",
  strategic_fit: "fit",
};

const AXIS_ORDER: AxisKey[] = ["eligibility", "timeline", "budget", "fit"];

const AXIS_LABELS: Record<AxisKey, string> = {
  eligibility: "Eligibility",
  timeline: "Timeline",
  budget: "Budget fit",
  fit: "Strategic fit",
};

/**
 * Checks with no home in AXIS_OF are dropped rather than crashing — a rule
 * added later without a category should degrade to "not grouped", not break
 * every match on the page.
 */
export function axisBreakdown(checks: readonly RuleResult[]): Axis[] {
  const byAxis = new Map<AxisKey, RuleResult[]>();
  for (const check of checks) {
    const axis = AXIS_OF[check.key];
    if (!axis) continue;
    const list = byAxis.get(axis);
    if (list) list.push(check);
    else byAxis.set(axis, [check]);
  }

  return AXIS_ORDER.filter((axis) => byAxis.has(axis)).map((axis) => {
    const list = byAxis.get(axis)!;
    const failed = list.filter((c) => c.status === "fail");
    const passed = list.filter((c) => c.status === "pass");
    const unknown = list.filter((c) => c.status === "unknown");

    const status: AxisStatus =
      passed.length === list.length
        ? "pass"
        : failed.length === list.length
          ? "fail"
          : unknown.length === list.length
            ? "unknown"
            : "partial";

    return {
      key: axis,
      label: AXIS_LABELS[axis],
      status,
      decisive: failed.some((c) => c.isHardGate),
      reasons: list.map((c) => c.detail),
    };
  });
}
