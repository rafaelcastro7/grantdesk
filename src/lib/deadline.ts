/**
 * When a published deadline date actually ends.
 *
 * A funder that says "closes October 5" means the end of October 5 where it
 * operates. Reading that as 23:59 UTC closed Eastern-time calls at 7–8 pm on
 * their last day, and day counts in reminders were off by one. Canadian and US
 * federal calls in this catalog are overwhelmingly Eastern, so that is the
 * default zone.
 */
export const DEFAULT_DEADLINE_ZONE = "America/Toronto";

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - utcMs;
}

/** The instant a `YYYY-MM-DD` deadline ends in `timeZone`, or NaN if unreadable. */
export function deadlineEnd(deadline: string, timeZone = DEFAULT_DEADLINE_ZONE): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deadline.trim());
  if (!match) return Number.NaN;
  const naive = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59);
  return naive - zoneOffsetMs(naive, timeZone);
}

/** Whole days left until the deadline ends; negative once it has passed. */
export function daysUntilDeadline(deadline: string, now: Date): number {
  const end = deadlineEnd(deadline);
  if (Number.isNaN(end)) return Number.NaN;
  const ms = end - now.getTime();
  return ms < 0 ? Math.floor(ms / 86_400_000) : Math.ceil(ms / 86_400_000);
}
