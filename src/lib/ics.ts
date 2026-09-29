/**
 * An iCalendar (RFC 5545) file of deadlines, so what is due lands in the
 * calendar a consultant already lives in — Google, Outlook, Apple — without
 * an integration to maintain. All-day events on the deadline date, with a
 * reminder a week out and a day out.
 */

export type CalendarDeadline = {
  uid: string;
  title: string;
  client: string;
  deadline: string; // YYYY-MM-DD
  url?: string | null;
  note?: string | null;
};

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Lines over 75 octets are folded, as the spec requires. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export function buildIcs(events: readonly CalendarDeadline[], now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GrantDesk//Deadlines//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:GrantDesk deadlines",
  ];
  for (const e of events) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.deadline)) continue;
    const description = [e.client, e.note, e.url].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}@grantdesk`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${e.deadline.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${nextDay(e.deadline)}`,
      fold(`SUMMARY:${escapeText(`Due: ${e.title} (${e.client})`)}`),
      fold(`DESCRIPTION:${escapeText(description)}`),
      ...(e.url ? [fold(`URL:${e.url}`)] : []),
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-P7D",
      fold(`DESCRIPTION:${escapeText(`One week left: ${e.title}`)}`),
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-P1D",
      fold(`DESCRIPTION:${escapeText(`Due tomorrow: ${e.title}`)}`),
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}
