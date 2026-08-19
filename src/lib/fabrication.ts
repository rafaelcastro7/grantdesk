/**
 * What did this draft claim that nobody told it?
 *
 * The product's central promise is that a draft never invents a fact. Checking
 * that needs a checker, and the first one only looked at digits — which missed
 * the two worst cases outright.
 *
 * Measured against three local models asked for a section needing a fact
 * nobody supplied:
 *
 *   "John Smith, Project Manager - MBA, 10 years of experience"
 *   "Dr. Elena Rossi, an environmental scientist with over fifteen years"
 *
 * The first was caught by the digit check. The second was not: "fifteen" is
 * not a digit. And *neither* invented person was caught at all, because a
 * fabricated name contains no number — and a named person with invented
 * credentials, in a document a funder reads, is the most damaging thing this
 * product could produce.
 *
 * Deliberately not a model judging a model. Every check here is a decidable
 * one against the facts that were supplied, so the answer is the same every
 * time and a failure points at a specific string.
 */

const SPELLED_NUMBERS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
] as const;

/** Titles that mark what follows as a person rather than a place or a programme. */
const PERSON_TITLES = ["Dr", "Dr.", "Prof", "Prof.", "Mr", "Mr.", "Ms", "Ms.", "Mrs", "Mrs."];

export type Fabrication = {
  kind: "number" | "spelled-number" | "person";
  text: string;
};

/** Gaps the model marked instead of filling are correct behaviour, not claims. */
function withoutGaps(draft: string): string {
  return (
    draft
      .replace(/\[NEED:[^\]]*\]/g, " ")
      // A list marker is not a claim. "1. Staffing 2. Materials" was being
      // counted as two invented figures, and a metric with false positives
      // gets argued with instead of acted on.
      .replace(/^\s*\d{1,2}[.)]\s/gm, " ")
  );
}

function permittedNumbers(facts: readonly string[]): Set<string> {
  const permitted = new Set<string>();
  for (const fact of facts) {
    for (const number of fact.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
      permitted.add(number.replace(/,/g, ""));
    }
    for (const word of fact.toLowerCase().match(/[a-z]+/g) ?? []) {
      if ((SPELLED_NUMBERS as readonly string[]).includes(word)) permitted.add(word);
    }
  }
  return permitted;
}

/**
 * Names the draft introduced that appear nowhere in the supplied facts.
 *
 * Two capitalised words in a row, or a title followed by a capitalised word.
 * Deliberately narrow: this is looking for invented people, and a rule loose
 * enough to catch every possible one would flag "Ravine Keepers" and "Urban
 * Greening Fund" on every draft, at which point nobody reads its output.
 */
function inventedPeople(text: string, facts: readonly string[]): string[] {
  const haystack = facts.join(" ").toLowerCase();
  const found = new Set<string>();

  const titled = text.match(/\b(?:Dr|Prof|Mr|Ms|Mrs)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g) ?? [];
  for (const match of titled) {
    const name = match.replace(/^\S+\.?\s+/, "");
    if (!haystack.includes(name.toLowerCase())) found.add(match);
  }

  // A bare "Firstname Lastname" immediately followed by a role or a comma is
  // the shape these fabrications take: "John Smith, Project Manager".
  const bare = text.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+(?=,\s*[A-Z]?[a-z])/g) ?? [];
  for (const match of bare) {
    if (haystack.includes(match.toLowerCase())) continue;
    if (PERSON_TITLES.some((title) => match.startsWith(title))) continue;
    found.add(match);
  }

  return [...found];
}

/**
 * Everything in the draft that was not in the facts it was given.
 *
 * `facts` is every string the model was shown — profile fields, stored answers,
 * the call's own figures. Anything numeric or personal outside that set is
 * something the model supplied itself.
 */
export function fabrications(draft: string, facts: readonly string[]): Fabrication[] {
  const body = withoutGaps(draft);
  const permitted = permittedNumbers(facts);
  const out: Fabrication[] = [];

  for (const raw of body.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const number = raw.replace(/,/g, "");
    if (!permitted.has(number) && !permitted.has(number.replace(/\.\d+$/, ""))) {
      out.push({ kind: "number", text: raw });
    }
  }

  for (const word of body.toLowerCase().match(/[a-z]+/g) ?? []) {
    if ((SPELLED_NUMBERS as readonly string[]).includes(word) && !permitted.has(word)) {
      out.push({ kind: "spelled-number", text: word });
    }
  }

  for (const person of inventedPeople(body, facts)) {
    out.push({ kind: "person", text: person });
  }

  // Deduplicated: the same invented figure repeated three times is one
  // fabrication to fix, not three.
  const seen = new Set<string>();
  return out.filter((f) => {
    const key = `${f.kind}:${f.text.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
