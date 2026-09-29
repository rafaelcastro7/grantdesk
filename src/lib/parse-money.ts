/**
 * An amount a consultant typed: "50000", "$50,000", "50k", "1.5M".
 *
 * Returns null for an empty field and NaN for something it cannot read, so the
 * form can refuse the save and say which field — silently storing "50k" as
 * nothing, or "1.000,50" as 1.0005, is how a brief ends up misstating the ask.
 */
export function parseMoney(raw: string): number | null {
  const text = raw
    .trim()
    .replace(/^[A-Z]{3}\s*/i, "")
    .replace(/[$\s]/g, "");
  if (!text) return null;
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?([kKmM])?$/.exec(text);
  if (!match) return Number.NaN;
  const base = Number(`${match[1]!.replace(/,/g, "")}${match[2] ?? ""}`);
  const scale = match[3] ? (match[3].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1;
  return base * scale;
}
