/**
 * No writing before a recorded go.
 *
 * The client's own SOP makes this non-negotiable: leadership sees the one-page
 * Opportunity Brief and records a decision before any drafting starts. A
 * go-conditional only opens drafting once its named condition is marked met —
 * otherwise "conditional" is a go with an excuse attached.
 */

export type Decision = "pending" | "go" | "no_go" | "go_conditional";

export type DecisionState = {
  decision: Decision;
  decidedBy: string | null;
  condition: string | null;
  conditionMet: boolean;
};

export type DraftingGate = { allowed: true } | { allowed: false; reason: string };

export function draftingGate(state: DecisionState | null, required = true): DraftingGate {
  if (!required) return { allowed: true };
  if (!state || state.decision === "pending") {
    return {
      allowed: false,
      reason:
        "Leadership has not recorded a go / no-go on the Opportunity Brief yet. No writing starts before that decision.",
    };
  }
  if (!state.decidedBy?.trim()) {
    return { allowed: false, reason: "The decision has no named approver." };
  }
  if (state.decision === "no_go") {
    return {
      allowed: false,
      reason: "Leadership decided no-go. The record is kept so it can be revisited next cycle.",
    };
  }
  if (state.decision === "go_conditional" && !state.conditionMet) {
    return {
      allowed: false,
      reason: `Go-conditional: "${state.condition ?? "the named condition"}" must be confirmed met with leadership before writing.`,
    };
  }
  return { allowed: true };
}

export type DecisionRow = {
  decision: Decision;
  decided_by: string | null;
  condition: string | null;
  condition_met: boolean;
};

export function fromRow(row: DecisionRow | null | undefined): DecisionState | null {
  if (!row) return null;
  return {
    decision: row.decision,
    decidedBy: row.decided_by,
    condition: row.condition,
    conditionMet: row.condition_met,
  };
}
