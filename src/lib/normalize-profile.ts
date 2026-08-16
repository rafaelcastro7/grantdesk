/**
 * Normalize what a model actually returns into what matching needs.
 *
 * Measured, not assumed: asked for ISO-like jurisdiction codes, real providers
 * answer `["Canada","North America"]`; asked for a stage from a fixed set they
 * answer `"seed-stage"`; asked for prose they sometimes answer with an array.
 * None of that is wrong — it is a reasonable reading of the page — so the
 * defect was a schema strict enough to reject good answers.
 *
 * Be liberal in what you accept, strict in what you store. Everything here is
 * pure and unit-tested, because this is where a silent mistranslation would
 * turn "operates in Ontario" into a match for a Prince Edward Island program.
 */

export const COUNTRIES: Record<string, string> = {
  canada: "CA",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  "u.s.": "US",
  us: "US",
  mexico: "MX",
  méxico: "MX",
  brazil: "BR",
  brasil: "BR",
  chile: "CL",
  colombia: "CO",
  argentina: "AR",
  peru: "PE",
  perú: "PE",
};

export const CA_PROVINCES: Record<string, string> = {
  ontario: "ON",
  quebec: "QC",
  québec: "QC",
  "british columbia": "BC",
  alberta: "AB",
  manitoba: "MB",
  saskatchewan: "SK",
  "nova scotia": "NS",
  "new brunswick": "NB",
  "newfoundland and labrador": "NL",
  newfoundland: "NL",
  "prince edward island": "PE",
  yukon: "YT",
  "northwest territories": "NT",
  nunavut: "NU",
};

/**
 * Continent- or planet-scale answers. They are true and useless: every grant
 * on the continent would "match", which is precisely the false-positive
 * problem this product exists to avoid.
 */
const TOO_BROAD = new Set([
  "north america",
  "south america",
  "latin america",
  "the americas",
  "americas",
  "global",
  "worldwide",
  "international",
  "everywhere",
]);

const clean = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/** Already-canonical codes: "CA", "ON", "US-CA", "CA-ON". */
function asCode(raw: string): string | null {
  const value = raw.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(value)) return value;
  if (/^[A-Z]{2}-[A-Z0-9]{2,3}$/.test(value)) return value;
  return null;
}

export function normalizeJurisdictions(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  const out: string[] = [];

  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const value = clean(entry);
    if (!value || TOO_BROAD.has(value)) continue;

    const code = asCode(entry);
    if (code) {
      out.push(code);
      continue;
    }
    const country = COUNTRIES[value];
    if (country) {
      out.push(country);
      continue;
    }
    const province = CA_PROVINCES[value];
    if (province) {
      // A province implies its country: a client in Ontario is eligible for
      // federal programs too, and matching must see both.
      out.push("CA", province);
    }
  }

  return [...new Set(out)];
}

const STAGES = ["startup", "sme", "nonprofit", "research", "public", "unknown"] as const;
export type Stage = (typeof STAGES)[number];

const STAGE_HINTS: Array<[RegExp, Stage]> = [
  [/non-?profit|not-?for-?profit|charity|charitable|ngo/, "nonprofit"],
  [/seed|pre-?seed|early-?stage|start-?up|scale-?up|venture/, "startup"],
  [/universit|research|academ|institute|laborator/, "research"],
  [/government|municipal|public sector|crown|agency/, "public"],
  [/sme|small.{0,12}medium|small business|enterprise|company|corporation|firm/, "sme"],
];

export function normalizeStage(input: unknown): Stage {
  if (typeof input !== "string") return "unknown";
  const value = clean(input);
  if ((STAGES as readonly string[]).includes(value)) return value as Stage;
  for (const [pattern, stage] of STAGE_HINTS) {
    if (pattern.test(value)) return stage;
  }
  return "unknown";
}

/** Accepts prose or a list of phrases; stores prose. */
export function normalizeProse(input: unknown, maxChars = 1200): string | null {
  const text = Array.isArray(input)
    ? input.filter((v): v is string => typeof v === "string" && v.trim().length > 0).join("; ")
    : typeof input === "string"
      ? input
      : "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars).trimEnd() : trimmed;
}

export function normalizeSectors(input: unknown, max = 8): string[] {
  const list = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[,;]/) : [];
  const out = list
    .filter((v): v is string => typeof v === "string")
    .map((v) =>
      clean(v)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter((v) => v.length >= 2);
  return [...new Set(out)].slice(0, max);
}

/** Budgets arrive as numbers, "750,000", or "$750K". */
export function normalizeBudget(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? input : null;
  if (typeof input !== "string") return null;

  const match = /(\d[\d,.\s]*)\s*(k|m|million|thousand|bn|billion)?/i.exec(
    input.replace(/\$/g, ""),
  );
  if (!match?.[1]) return null;

  const digits = Number(match[1].replace(/[,\s]/g, ""));
  if (!Number.isFinite(digits) || digits <= 0) return null;

  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === "k" || unit === "thousand"
      ? 1_000
      : unit === "m" || unit === "million"
        ? 1_000_000
        : unit === "bn" || unit === "billion"
          ? 1_000_000_000
          : 1;

  return digits * multiplier;
}
