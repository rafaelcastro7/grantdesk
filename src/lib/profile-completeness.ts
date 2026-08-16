/**
 * How usable is a client profile, and what exactly is missing?
 *
 * This is product logic, not a progress bar. Matching quality decays with a
 * stale or thin profile, and the incumbent's best-documented failure is users
 * who fill a profile once and never revisit it while their matches quietly
 * drift irrelevant. A consultant with eight clients has eight chances to hit
 * that, so "what is missing" has to be specific enough to act on in seconds.
 *
 * Fields are weighted by what they actually block:
 *   - required: an eligibility gate cannot run without them
 *   - important: matching works but ranks poorly
 *   - helpful: improves drafting, never blocks a match
 */

export type ProfileFields = {
  sectors?: string[] | null;
  jurisdictions?: string[] | null;
  stage?: string | null;
  annualBudget?: number | null;
  capabilities?: string | null;
  beneficiaries?: string | null;
};

export type FieldWeight = "required" | "important" | "helpful";

export type MissingField = {
  key: keyof ProfileFields;
  weight: FieldWeight;
  /** Written for the consultant, naming the consequence rather than the field. */
  prompt: string;
};

export type Completeness = {
  score: number; // 0-100
  missing: MissingField[];
  /** False when any required field is absent: matching must not run yet. */
  canMatch: boolean;
};

const FIELDS: Array<{
  key: keyof ProfileFields;
  weight: FieldWeight;
  points: number;
  prompt: string;
}> = [
  {
    key: "jurisdictions",
    weight: "required",
    points: 30,
    prompt:
      "Where does this client operate? Without it we cannot rule out grants they are not eligible for.",
  },
  {
    key: "sectors",
    weight: "required",
    points: 30,
    prompt: "What sectors does this client work in? Without it every result is a keyword guess.",
  },
  {
    key: "stage",
    weight: "important",
    points: 15,
    prompt: "Startup, SME, established nonprofit? Many programs are restricted by stage.",
  },
  {
    key: "annualBudget",
    weight: "important",
    points: 15,
    prompt:
      "Roughly what is their annual budget? Some funders screen on size before anything else.",
  },
  {
    key: "capabilities",
    weight: "helpful",
    points: 5,
    prompt: "What have they actually delivered? This is what drafting quotes back to a funder.",
  },
  {
    key: "beneficiaries",
    weight: "helpful",
    points: 5,
    prompt: "Who benefits from their work? Useful for impact sections.",
  },
];

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  return true;
}

export function assessProfile(profile: ProfileFields): Completeness {
  let score = 0;
  const missing: MissingField[] = [];

  for (const field of FIELDS) {
    if (isPresent(profile[field.key])) {
      score += field.points;
    } else {
      missing.push({ key: field.key, weight: field.weight, prompt: field.prompt });
    }
  }

  return {
    score,
    missing,
    canMatch: !missing.some((m) => m.weight === "required"),
  };
}

/**
 * The single next thing worth asking for. A list of six gaps gets ignored; one
 * concrete question gets answered.
 */
export function nextGap(completeness: Completeness): MissingField | null {
  const order: FieldWeight[] = ["required", "important", "helpful"];
  for (const weight of order) {
    const found = completeness.missing.find((m) => m.weight === weight);
    if (found) return found;
  }
  return null;
}
