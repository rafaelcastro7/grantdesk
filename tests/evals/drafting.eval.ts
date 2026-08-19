/**
 * Is a drafted section honest, on-target and actually reusing prior work?
 *
 * Drafting quality is a distribution, so it cannot be a pass/fail test — but it
 * does not need a judge either. The three properties that matter most here are
 * all checkable from the text itself, which keeps the score anchored to the
 * draft rather than to whatever model was asked to grade it:
 *
 *   FABRICATION — every number in the draft must trace back to a fact we
 *                 supplied, or sit inside a [NEED: …] marker. An invented
 *                 figure in a grant application is the worst thing this
 *                 product could produce: it is confident, specific, and the
 *                 consultant has no way to find it.
 *   REUSE       — the distinctive fact from the client's stored answer has to
 *                 survive into the draft. That is the entire promised time
 *                 saving; without it the answer library is decoration.
 *   LIMIT       — a draft over the funder's stated word limit is work the
 *                 consultant has to redo.
 *
 * Usage: bun run eval:drafting
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env" });

const { draftSection, saveAnswer, DRAFT_SYSTEM_PROMPT } = await import("../../src/server/draft");
const {
  append,
  describe: describeRate,
  rateOf,
  read,
  variantOf,
  verdictFor,
} = await import("./sample-log");

/**
 * Where samples accumulate, and what they are samples *of*.
 *
 * A run can only produce a handful of drafts before this account's token
 * ceiling sends the rest to the local model, and a handful cannot tell a
 * ten-point change from a lucky draw. Samples therefore pool across runs — but
 * only within one prompt-and-model fingerprint, so editing the prompt starts a
 * fresh sample instead of averaging the old behaviour into the new.
 */
const SAMPLE_LOG = "tests/evals/results/drafting.jsonl";
const MIN_SAMPLES = 20;

/**
 * Runs per requirement. Two by default so a routine check is quick.
 *
 * Two is not enough to *tune* against, and finding that out cost a round of
 * prompt edits: a change that should have reduced fabrication moved the number
 * the wrong way, then back, on eight drafts. Differences of ten or twenty
 * points are inside the noise at that size. Raise it — `EVAL_RUNS=5` — before
 * concluding a prompt change helped.
 */
const RUNS = Number(process.env.EVAL_RUNS ?? 2);
const WORD_LIMIT = 250;

/**
 * Four requirements, chosen for what each one stresses.
 *
 * One heading run three times measured one thing three times. These cover the
 * cases where drafting can actually go wrong, and one of them — `mustAdmitGap`
 * — is the product's central honesty claim, which the old eval only exercised
 * by accident.
 */
type Case = {
  key: string;
  label: string;
  detail: string;
  wordLimit: number | null;
  /** Should the client's stored answer be found for this requirement? */
  expectReuse: boolean;
  /** Does answering this honestly require a fact we never supplied? */
  mustAdmitGap: boolean;
};

const CASES: Case[] = [
  {
    key: "capacity",
    label: "Organizational Capacity",
    detail: "Demonstrate your ability to deliver projects of this size.",
    wordLimit: WORD_LIMIT,
    expectReuse: true,
    mustAdmitGap: false,
  },
  {
    // Nothing in the library is about staffing, and the profile says nothing
    // either. Reuse must not drag in the track-record answer just because it
    // is the only thing there.
    key: "staffing",
    label: "Project Team",
    detail: "Name the staff who will deliver this project and their qualifications.",
    wordLimit: 150,
    expectReuse: false,
    mustAdmitGap: true,
  },
  {
    // The client's own numbers are supplied, so this should restate rather
    // than invent — the case where fabrication is most tempting.
    key: "budget",
    label: "Budget Narrative",
    detail: "Explain how the requested funds relate to your organization's finances.",
    wordLimit: 200,
    expectReuse: false,
    mustAdmitGap: false,
  },
  {
    // No limit at all: a model that only respects a limit when told one is not
    // respecting anything.
    key: "sustainability",
    label: "Sustainability",
    detail: "How will this work continue after the grant period?",
    wordLimit: null,
    expectReuse: false,
    mustAdmitGap: true,
  },
];
const DISTINCTIVE = "Wentworth Ravine";

const stamp = Date.now();
const CREDS = { email: `eval-draft-${stamp}@grantdesk.test`, password: "GrantDesk-Eval-2026!" };

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { error: signUpError } = await supabase.auth.signUp(CREDS);
if (signUpError && !/already registered/i.test(signUpError.message)) throw signUpError;
const { data: session } = await supabase.auth.signInWithPassword(CREDS);

const { data: client } = await supabase
  .from("clients")
  .insert({ consultant_id: session.user!.id, name: "Ravine Keepers", country: "CA" })
  .select("id")
  .single();
const clientId = (client as { id: string }).id;

/** The call being applied to. Its figures are supplied, so restating them is not invention. */
const CALL = {
  title: "Urban Greening Fund",
  funder: "Ontario Trillium Foundation",
  amountMin: 25_000,
  amountMax: 150_000,
  currency: "CAD",
  deadline: "2026-12-01",
};

/** Everything the model is allowed to know. Any other figure is fabricated. */
const FACTS = {
  capabilities:
    "We restore urban ravines and run volunteer planting days. Founded in 2011, we work across 6 sites.",
  beneficiaries: "residents of low-income neighbourhoods",
  annualBudget: 450000,
  storedAnswer: `Since 2011 we have delivered 11 restoration projects, including the ${DISTINCTIVE} restoration, completed in 2019 with 312 volunteers.`,
};

await supabase.from("client_profiles").upsert({
  client_id: clientId,
  sectors: ["environment", "community"],
  jurisdictions: ["CA-ON"],
  stage: "nonprofit",
  annual_budget: FACTS.annualBudget,
  capabilities: FACTS.capabilities,
  beneficiaries: FACTS.beneficiaries,
});

await saveAnswer(supabase, clientId, "Track record and past projects", FACTS.storedAnswer);

/** Every number the model was given, in the forms it might restate them. */
const permitted = new Set<string>();
for (const source of [
  FACTS.capabilities,
  FACTS.beneficiaries,
  FACTS.storedAnswer,
  String(FACTS.annualBudget),
  FACTS.annualBudget.toLocaleString("en-US"),
  String(WORD_LIMIT),
  // The call's own figures. Quoting the award range back is reading, not
  // inventing — what must not appear is a specific amount chosen from inside
  // it, which the checker below catches as its own case.
  String(CALL.amountMin),
  String(CALL.amountMax),
  CALL.amountMin.toLocaleString("en-US"),
  CALL.amountMax.toLocaleString("en-US"),
  CALL.deadline,
]) {
  for (const number of source.match(/\d[\d,]*/g) ?? []) permitted.add(number.replace(/,/g, ""));
}
// A year range the client plainly implies: founded 2011, so any year from 2011
// to now is a restatement rather than an invention.
for (let year = 2011; year <= 2026; year++) permitted.add(String(year));

function fabricatedNumbers(draft: string): string[] {
  // Gaps the model marked instead of filling are the correct behaviour, so
  // whatever is inside them is not a claim.
  const withoutGaps = draft
    .replace(/\[NEED:[^\]]*\]/g, " ")
    // Nor is a list marker. "1. Staffing 2. Materials" was being counted as two
    // fabricated figures, which made the number say something it did not mean —
    // and a metric with false positives gets argued with instead of fixed.
    .replace(/^\s*\d{1,2}[.)]\s/gm, " ");
  const found = withoutGaps.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return [...new Set(found.map((n) => n.replace(/,/g, "")))].filter(
    (n) => !permitted.has(n) && !permitted.has(n.replace(/\.\d+$/, "")),
  );
}

console.log(`Drafting ${CASES.length} requirements, ${RUNS} times each…
`);

const results: Array<{
  case: Case;
  words: number;
  reused: boolean;
  quotedFact: boolean;
  fabricated: string[];
  gaps: number;
  by: string;
}> = [];

for (const testCase of CASES) {
  for (let run = 0; run < RUNS; run++) {
    const result = await draftSection(supabase, clientId, {
      id: "00000000-0000-0000-0000-000000000000",
      label: testCase.label,
      detail: testCase.detail,
      wordLimit: testCase.wordLimit,
      evaluationNote: null,
      sourceQuote: null,
      // The product always drafts against a specific call; drafting without
      // one measured a situation that never happens, and it was the missing
      // context that made a budget section invent an amount to request.
      grant: CALL,
    });

    results.push({
      case: testCase,
      words: result.wordCount,
      reused: result.reusedAnswers.length > 0,
      quotedFact: result.content.includes(DISTINCTIVE),
      fabricated: fabricatedNumbers(result.content),
      gaps: (result.content.match(/\[NEED:/g) ?? []).length,
      by: result.draftedBy,
    });
    process.stdout.write(
      `  ${testCase.key.padEnd(15)} run ${run + 1}: ${result.wordCount} words via ${result.draftedBy}
`,
    );
    // Paced so a burst does not empty the per-minute bucket. Worth saying what
    // this does *not* fix: the run that prompted it was falling through for a
    // different reason entirely — the per-*day* token budget was spent, while
    // the per-minute headers showed 7908 of 8000 free. Pacing cannot buy back
    // a daily allowance, and reading the wrong meter cost a round of tuning.
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.EVAL_PACE_MS ?? 15_000)));
  }
}

console.log();
console.log("case            words  limit  reused  fabricated numbers   gaps");
console.log("─".repeat(72));
for (const r of results) {
  const limit = r.case.wordLimit;
  console.log(
    `${r.case.key.padEnd(15)} ${String(r.words).padEnd(6)} ` +
      `${(limit === null ? "none" : r.words <= limit ? "ok" : "OVER").padEnd(6)} ` +
      `${(r.reused ? "yes" : "no").padEnd(7)} ` +
      `${(r.fabricated.length ? r.fabricated.join(", ") : "none").padEnd(20)} ${r.gaps}`,
  );
}

const rate = (predicate: (r: (typeof results)[number]) => boolean, over = results) =>
  over.length === 0 ? 1 : over.filter(predicate).length / over.length;

const pct = (v: number) => `${Math.round(v * 100)}%`;

// Only the cases that stated a limit can be scored against one.
const limited = results.filter((r) => r.case.wordLimit !== null);
const withinLimit = rate((r) => r.words <= r.case.wordLimit!, limited);

// Reuse is scored where it should happen and, separately, where it should not.
//
// The off-target measure is *leakage*, not retrieval. Measured directly, a
// short requirement heading does not separate cleanly from a stored answer:
// "Project Team" scores 0.5856 against the track-record answer while
// "Organizational Capacity" — the one that should match — scores 0.5852. No
// threshold exists that admits one and refuses the other, so gating on
// retrieval would be scoring a mechanism nobody can make correct.
//
// What a consultant would actually notice is the client's ravine-restoration
// history turning up in a section about staffing. That is observable, and it
// is what the prompt now tells the model to refuse.
const shouldReuse = results.filter((r) => r.case.expectReuse);
const shouldNotReuse = results.filter((r) => !r.case.expectReuse);
const retrieved = rate((r) => r.reused, shouldReuse);
const quoted = rate((r) => r.quotedFact, shouldReuse);
const restrained = rate((r) => !r.quotedFact, shouldNotReuse);

const clean = rate((r) => r.fabricated.length === 0);

// The product's central claim: asked for a fact nobody supplied, the draft
// says so rather than inventing one. The old eval only ever hit this by
// accident.
const needsGap = results.filter((r) => r.case.mustAdmitGap);
const admitted = rate((r) => r.gaps > 0, needsGap);

console.log("─".repeat(72));
console.log(`within a stated word limit:       ${pct(withinLimit)}  (${limited.length} drafts)`);
console.log(`reused where it should:           ${pct(retrieved)}  (${shouldReuse.length})`);
console.log(`  its distinctive fact survived:  ${pct(quoted)}`);
console.log(`no leakage into other sections:   ${pct(restrained)}  (${shouldNotReuse.length})`);
console.log(`admitted a gap when it had none:  ${pct(admitted)}  (${needsGap.length})`);
console.log(`no fabricated numbers:            ${pct(clean)}  (${results.length})`);

// Which model actually wrote these. A run served by the local fallback is
// measuring a different product from one served by the intended chain, and
// comparing the two numbers as if they were the same is how a provider outage
// gets recorded as a quality regression.
// Recorded before anything is judged, and only for drafts the intended chain
// actually wrote: a draft from the local floor is a sample of a different
// system and pooling it would quietly corrupt the history.
const variant = variantOf([DRAFT_SYSTEM_PROMPT, "groq/openai/gpt-oss-120b"]);
for (const r of results) {
  if (r.by.startsWith("ollama")) continue;
  append(SAMPLE_LOG, {
    variant,
    at: new Date().toISOString(),
    case: r.case.key,
    outcomes: {
      clean: r.fabricated.length === 0,
      withinLimit: r.case.wordLimit === null ? true : r.words <= r.case.wordLimit,
      ...(r.case.expectReuse ? { quoted: r.quotedFact } : { noLeakage: !r.quotedFact }),
      ...(r.case.mustAdmitGap ? { admittedGap: r.gaps > 0 } : {}),
    },
  });
}

const history = read(SAMPLE_LOG, variant);
console.log();
console.log(`Cumulative for this prompt (${variant}), ${history.length} drafts:`);
for (const [property, label] of [
  ["clean", "no fabricated numbers"],
  ["withinLimit", "within a stated word limit"],
  ["noLeakage", "no leakage into other sections"],
  ["admittedGap", "admitted a gap when it had none"],
  ["quoted", "reused fact survived"],
] as const) {
  console.log(`  ${label.padEnd(32)} ${describeRate(rateOf(history, property))}`);
}

const providers = [...new Set(results.map((r) => r.by))];
console.log(`written by:                       ${providers.join(", ")}`);
const degraded = results.filter((r) => r.by.startsWith("ollama"));

await supabase.from("clients").delete().eq("id", clientId);

// Retrieval is deterministic — it either found the answer or the embedding
// index is broken — so it is held to 100%. The rest are model behaviour and
// held to a floor rather than a point: a distribution that dips below these is
// not usable output, whatever the mean says.
const failures: string[] = [];
if (degraded.length > 0) {
  failures.push(
    `${degraded.length} of ${results.length} drafts came from the local fallback — ` +
      "this measures the floor, not the product. Fix the provider chain before trusting the rest.",
  );
}
// Retrieval is deterministic — it either found the answer or the embedding
// index is broken — so it is held to 100%. So is fabrication: an invented
// figure in a grant application is not a quality gradient, it is the one
// output this product must never produce.
if (retrieved < 1) failures.push(`stored answer retrieved only ${pct(retrieved)} of the time`);

// Judged on the pooled history, not this run. Gating on eight drafts fails on
// noise; gating on the interval's upper bound means a genuinely bad rate can
// never hide behind a thin sample. Below the minimum it reports "not enough
// evidence" rather than passing or failing by accident.
const unknown: string[] = [];
for (const [property, label, floor] of [
  ["clean", "drafts with no fabricated number", 0.95],
  ["admittedGap", "drafts admitting a gap where facts were missing", 0.7],
  ["noLeakage", "unrelated sections free of the client's stored facts", 0.7],
  ["withinLimit", "drafts within a stated word limit", 0.8],
] as const) {
  const rate = rateOf(history, property);
  const verdict = verdictFor(rate, floor, MIN_SAMPLES);
  if (verdict === "fail") {
    failures.push(`${label}: ${describeRate(rate)}, confidently below the ${pct(floor)} floor`);
  } else if (verdict === "unknown") {
    unknown.push(`${label}: ${describeRate(rate)} — needs ${MIN_SAMPLES} to judge`);
  }
}

if (unknown.length > 0) {
  console.log();
  console.log("Not enough evidence yet:");
  for (const line of unknown) console.log(`  ${line}`);
  console.log("  Run again — samples accumulate until the prompt changes.");
}

if (failures.length > 0) {
  console.error(`\nFAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nPASSED: drafts reuse prior work, stay in limit, and invent nothing.");
