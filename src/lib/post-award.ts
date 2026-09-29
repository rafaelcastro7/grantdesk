import { daysUntilDeadline } from "./deadline";

export const RENEWAL_WINDOW_DAYS = 120;
export const REMINDER_DAYS = [14, 7, 3, 1] as const;

export type ReportKind = "interim" | "final" | "financial" | "other";

export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  interim: "Interim report",
  final: "Final report",
  financial: "Financial report",
  other: "Report",
};

/**
 * An agreement ending within the window, and not yet ended. A date comparison,
 * not a likelihood: nothing here predicts whether the funder will renew.
 */
export function inRenewalWindow(endOn: string | null, now: Date): boolean {
  if (!endOn) return false;
  const days = daysUntilDeadline(endOn, now);
  return days >= 0 && days <= RENEWAL_WINDOW_DAYS;
}

/** Whether today is one of the reminder days before a report falls due. */
export function isReminderDay(dueOn: string, now: Date): number | null {
  const days = daysUntilDeadline(dueOn, now);
  return (REMINDER_DAYS as readonly number[]).includes(days) ? days : null;
}
