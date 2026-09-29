import { GAP_MARKER } from "./submit-gate";
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

/**
 * Digits and words are the same claim.
 *
 * A draft restating a supplied "6 sites" as "six sites" is reading, not
 * inventing — and the first version of this flagged it, because the facts held
 * a digit and the draft held a word. Nearly every clean draft was scored as a
 * fabrication and the measured rate was meaningless.
 */
const NUMBER_WORDS: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  sixty: "60",
  seventy: "70",
  eighty: "80",
  ninety: "90",
};

const WORD_FOR_DIGIT: Record<string, string> = Object.fromEntries(
  Object.entries(NUMBER_WORDS).map(([word, digit]) => [digit, word]),
);

/**
 * French number words, as values. French drafts are routine for federal and
 * Quebec calls, and "quinze ans d'expérience" is the same invention as
 * "fifteen years of experience" — invisible to an English word list.
 * Compounds ("quatre-vingt-dix", "soixante et onze", "deux cent mille") are
 * combined by `frenchPhraseValue`, so only the atoms are listed.
 */
const FRENCH_UNITS: Record<string, number> = {
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  onze: 11,
  douze: 12,
  treize: 13,
  quatorze: 14,
  quinze: 15,
  seize: 16,
  vingt: 20,
  vingts: 20,
  trente: 30,
  quarante: 40,
  cinquante: 50,
  soixante: 60,
};
const FRENCH_MULTIPLIERS = new Set(["cent", "cents", "mille", "million", "millions"]);

function isFrenchNumberWord(word: string | undefined): boolean {
  if (word === undefined) return false;
  return word in FRENCH_UNITS || FRENCH_MULTIPLIERS.has(word);
}

/** Value of a run of French number words, e.g. ["quatre","vingt","dix"] → 90. */
export function frenchPhraseValue(words: readonly string[]): number {
  let total = 0;
  let current = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (word === "quatre" && (words[i + 1] === "vingt" || words[i + 1] === "vingts")) {
      current += 80;
      i++;
    } else if (word in FRENCH_UNITS) {
      current += FRENCH_UNITS[word] ?? 0;
    } else if (word === "cent" || word === "cents") {
      current = (current || 1) * 100;
    } else if (word === "mille") {
      total += (current || 1) * 1000;
      current = 0;
    } else if (word === "million" || word === "millions") {
      total += (current || 1) * 1_000_000;
      current = 0;
    }
  }
  return total + current;
}

type FrenchNumber = { text: string; value: number; start: number; end: number };

function isAfterPour(tokens: readonly string[], index: number): boolean {
  return /^\s+$/.test(tokens[index - 1] ?? "") && tokens[index - 2] === "pour";
}

/**
 * Runs of French number words joined by spaces, hyphens or "et".
 *
 * Some are also ordinary words and are not read as figures on their own:
 * "un"/"une" is the indefinite article, "neuf" means "new" unless a plural
 * noun follows ("neuf employés"), "cent" after "pour" is "pour cent" (the
 * figure before it is still checked), and "Sept." is the English month.
 * Flagging every article would bury the real inventions.
 */
function frenchNumbers(text: string): FrenchNumber[] {
  const matches = [...text.toLowerCase().matchAll(/[a-zà-ÿ]+|[^a-zà-ÿ]+/g)];
  const tokens = matches.map((m) => m[0]);
  const out: FrenchNumber[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!isFrenchNumberWord(tokens[i]) || (tokens[i] === "cent" && isAfterPour(tokens, i))) {
      i++;
      continue;
    }
    const words = [tokens[i] ?? ""];
    let end = i;
    let j = i + 1;
    while (j + 1 < tokens.length && /^[\s-]+$/.test(tokens[j] ?? "")) {
      const next = tokens[j + 1];
      if (isFrenchNumberWord(next)) {
        words.push(next ?? "");
        end = j + 1;
        j += 2;
      } else if (next === "et" && j + 3 < tokens.length && isFrenchNumberWord(tokens[j + 3])) {
        j += 2;
      } else break;
    }
    const after = tokens[end + 1] ?? "";
    const following = tokens[end + 2] ?? "";
    const single = words.length === 1 ? words[0] : null;
    const skip =
      single === "un" ||
      single === "une" ||
      (single === "sept" && after.startsWith(".")) ||
      (single === "neuf" && !(/^\s+$/.test(after) && /[sx]$/.test(following)));
    if (!skip) {
      const start = matches[i]?.index ?? 0;
      const last = matches[end];
      out.push({
        text: words.join(" "),
        value: frenchPhraseValue(words),
        start,
        end: (last?.index ?? 0) + (last?.[0].length ?? 0),
      });
    }
    i = end + 1;
  }
  return out;
}

/** "450 000" (French thousands grouping) is one number, not "450" and "000". */
const SPACE_GROUPED = /(?<![\d,.])\d{1,3}(?:[ \xa0\u202f]\d{3})+(?!\d)/g;

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
      .replace(GAP_MARKER, " ")
      // A list marker is not a claim. "1. Staffing 2. Materials" was being
      // counted as two invented figures, and a metric with false positives
      // gets argued with instead of acted on.
      .replace(/^\s*\d{1,2}[.)]\s/gm, " ")
  );
}

function permittedNumbers(facts: readonly string[]): Set<string> {
  const permitted = new Set<string>();
  for (const fact of facts) {
    for (const raw of fact.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
      const number = raw.replace(/,/g, "");
      permitted.add(number);
      // ...and its spelled form, so restating "6 sites" as "six sites" is not
      // read as an invention.
      const word = WORD_FOR_DIGIT[number];
      if (word) permitted.add(word);
    }
    for (const raw of fact.match(SPACE_GROUPED) ?? []) {
      permitted.add(raw.replace(/\D/g, ""));
    }
    for (const french of frenchNumbers(fact)) permitted.add(String(french.value));
    for (const word of fact.toLowerCase().match(/[a-z]+/g) ?? []) {
      if ((SPELLED_NUMBERS as readonly string[]).includes(word)) {
        permitted.add(word);
        const digit = NUMBER_WORDS[word];
        if (digit) permitted.add(digit);
      }
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
  const permitted = permittedNumbers(facts);
  const out: Fabrication[] = [];
  let body = withoutGaps(draft);

  for (const raw of body.match(SPACE_GROUPED) ?? []) {
    if (!permitted.has(raw.replace(/\D/g, ""))) out.push({ kind: "number", text: raw });
  }
  body = body.replace(SPACE_GROUPED, " ");

  // Checked by value, then blanked so the English pass below does not also
  // read the "six" inside "vingt-six" as a separate (and unsupported) claim.
  const french = frenchNumbers(body);
  for (const found of french) {
    const englishToo = (SPELLED_NUMBERS as readonly string[]).includes(found.text);
    if (englishToo) continue;
    if (!permitted.has(String(found.value))) out.push({ kind: "spelled-number", text: found.text });
  }
  for (const found of [...french].reverse()) {
    if ((SPELLED_NUMBERS as readonly string[]).includes(found.text)) continue;
    body = body.slice(0, found.start) + " ".repeat(found.end - found.start) + body.slice(found.end);
  }

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
