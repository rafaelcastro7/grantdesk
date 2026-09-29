import type { CalendarDeadline } from "@/lib/ics";

/**
 * Shared by "What is due" and the subscribable feed, so a calendar never shows
 * a different set of applications than the screen it was subscribed from.
 * In progress means real work exists (a section, a brief or an owner); a no-go is not
 * due, and a submitted application is no longer pending.
 */
export function isInProgress(row: {
  submissions: readonly unknown[];
  proposal_sections: readonly unknown[];
  decision?: string | null;
  assignments?: readonly unknown[];
}): boolean {
  return (
    row.submissions.length === 0 &&
    row.decision !== "no_go" &&
    (row.proposal_sections.length > 0 ||
      row.decision != null ||
      (row.assignments?.length ?? 0) > 0)
  );
}

export type FeedRow = {
  id: string;
  client_id: string;
  grant_id: string;
  clientName: string;
  title: string;
  deadline: string | null;
  estimatedDeadline: string | null;
  decision: string | null;
  submissions: readonly unknown[];
  proposal_sections: readonly unknown[];
};

export function feedEvents(rows: readonly FeedRow[], origin: string): CalendarDeadline[] {
  const events: CalendarDeadline[] = [];
  for (const row of rows) {
    if (!isInProgress(row)) continue;
    const url = `${origin}/clients/${row.client_id}/proposals/${row.grant_id}`;
    if (row.deadline) {
      events.push({
        uid: row.id,
        title: row.title,
        client: row.clientName,
        deadline: row.deadline,
        url,
      });
    } else if (row.estimatedDeadline) {
      // Labelled in the title, where it is seen: an estimate filed in a
      // calendar as if it were the deadline is how a call gets missed.
      events.push({
        uid: `${row.id}-estimate`,
        title: `${row.title} (estimate)`,
        client: row.clientName,
        deadline: row.estimatedDeadline,
        url,
        note: "Funder-estimated date for a forecast call. Not a deadline.",
      });
    }
  }
  return events;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** 32 random bytes, base64url: 43 characters, safe in a URL path. */
export function generateCalendarToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashCalendarToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function calendarFeedPath(token: string): string {
  return `/api/calendar/${token}`;
}
