import { daysUntilDeadline } from "./deadline";

/** Who has a requirement and by when — the firm's own date, not the funder's. */
export type Assignment = {
  requirementId: string;
  ownerId: string | null;
  dueOn: string | null;
  doneAt: string | null;
};

export type TeamMember = {
  clientId: string;
  userId: string;
  email: string;
  displayName: string | null;
  isOwner: boolean;
};

export function memberName(member: Pick<TeamMember, "email" | "displayName">): string {
  return member.displayName?.trim() || member.email;
}

/**
 * The words a blocker appends so the consultant knows whom to chase. Empty
 * when nothing is assigned: "owner: nobody" is worth saying only if there is
 * a due date to go with it.
 */
export function assignmentSuffix(owner: string | null, dueOn: string | null): string {
  if (!owner && !dueOn) return "";
  const parts = [
    owner ? `owner ${owner}` : "no owner",
    dueOn ? `due ${dueOn}` : "no internal due date",
  ];
  return ` (${parts.join(", ")})`;
}

/** The earliest open assignment, optionally only one person's. */
export function nextAssignment(
  assignments: Assignment[],
  ownerId: string | null = null,
): Assignment | null {
  const open = assignments.filter(
    (a) => !a.doneAt && a.dueOn && (ownerId === null || a.ownerId === ownerId),
  );
  open.sort((a, b) => a.dueOn!.localeCompare(b.dueOn!));
  return open[0] ?? null;
}

export type DueGroup = "overdue" | "this_week" | "later" | "closed";

/**
 * Where an unsent application belongs on the firm-wide list. The call closing
 * decides "closed"; otherwise the nearer of the funder's deadline and the
 * firm's own next due date decides, because an internal date that slipped is
 * overdue work even when the funder's deadline is a month away.
 */
export function dueGroup(deadline: string | null, nextDueOn: string | null, today: Date): DueGroup {
  if (deadline && daysUntilDeadline(deadline, today) < 0) return "closed";
  if (nextDueOn && daysUntilDeadline(nextDueOn, today) < 0) return "overdue";
  const days = [deadline, nextDueOn]
    .filter((d): d is string => !!d)
    .map((d) => daysUntilDeadline(d, today));
  if (days.length > 0 && Math.min(...days) <= 7) return "this_week";
  return "later";
}

/** Checks recorded with a date but nobody's name against them. */
export function unsignedChecks(
  checks: Record<string, [by: string | null, on: string | null]>,
): string[] {
  return Object.entries(checks)
    .filter(([, [by, on]]) => !!on && !by?.trim())
    .map(([name]) => name);
}
