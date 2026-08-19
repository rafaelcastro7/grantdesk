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

const { draftSection, saveAnswer } = await import("../../src/server/draft");

const RUNS = 3;
const WORD_LIMIT = 250;
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
]) {
  for (const number of source.match(/\d[\d,]*/g) ?? []) permitted.add(number.replace(/,/g, ""));
}
// A year range the client plainly implies: founded 2011, so any year from 2011
// to now is a restatement rather than an invention.
for (let year = 2011; year <= 2026; year++) permitted.add(String(year));

function fabricatedNumbers(draft: string): string[] {
  // Gaps the model marked instead of filling are the correct behaviour, so
  // whatever is inside them is not a claim.
  const withoutGaps = draft.replace(/\[NEED:[^\]]*\]/g, " ");
  const found = withoutGaps.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return [...new Set(found.map((n) => n.replace(/,/g, "")))].filter(
    (n) => !permitted.has(n) && !permitted.has(n.replace(/\.\d+$/, "")),
  );
}

console.log(`Drafting "Organizational Capacity" ${RUNS} times…\n`);

const results: Array<{
  words: number;
  reused: boolean;
  quotedFact: boolean;
  fabricated: string[];
  gaps: number;
  by: string;
}> = [];

for (let run = 0; run < RUNS; run++) {
  const result = await draftSection(supabase, clientId, {
    id: "00000000-0000-0000-0000-000000000000",
    label: "Organizational Capacity",
    detail: "Demonstrate your ability to deliver projects of this size.",
    wordLimit: WORD_LIMIT,
    evaluationNote: "Scored on evidence of comparable completed work.",
    sourceQuote: "Applicants must demonstrate organizational capacity.",
  });

  results.push({
    words: result.wordCount,
    reused: result.reusedAnswers.length > 0,
    quotedFact: result.content.includes(DISTINCTIVE),
    fabricated: fabricatedNumbers(result.content),
    gaps: (result.content.match(/\[NEED:/g) ?? []).length,
    by: result.draftedBy,
  });
  process.stdout.write(`  run ${run + 1}: ${result.wordCount} words via ${result.draftedBy}\n`);
}

console.log();
console.log("run  words  limit  retrieved  quoted fact  fabricated numbers  gaps");
console.log("─".repeat(72));
results.forEach((r, i) => {
  console.log(
    `${String(i + 1).padEnd(4)} ${String(r.words).padEnd(6)} ` +
      `${(r.words <= WORD_LIMIT ? "ok" : "OVER").padEnd(6)} ` +
      `${(r.reused ? "yes" : "no").padEnd(10)} ` +
      `${(r.quotedFact ? "yes" : "no").padEnd(12)} ` +
      `${(r.fabricated.length ? r.fabricated.join(", ") : "none").padEnd(19)} ${r.gaps}`,
  );
});

const rate = (predicate: (r: (typeof results)[number]) => boolean) =>
  results.filter(predicate).length / results.length;

const withinLimit = rate((r) => r.words <= WORD_LIMIT);
const retrieved = rate((r) => r.reused);
const quoted = rate((r) => r.quotedFact);
const clean = rate((r) => r.fabricated.length === 0);

const pct = (v: number) => `${Math.round(v * 100)}%`;

console.log("─".repeat(72));
console.log(`within the word limit:            ${pct(withinLimit)}`);
console.log(`stored answer retrieved:          ${pct(retrieved)}`);
console.log(`its distinctive fact survived:    ${pct(quoted)}`);
console.log(`no fabricated numbers:            ${pct(clean)}`);

// Which model actually wrote these. A run served by the local fallback is
// measuring a different product from one served by the intended chain, and
// comparing the two numbers as if they were the same is how a provider outage
// gets recorded as a quality regression.
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
if (retrieved < 1) failures.push(`stored answer retrieved only ${pct(retrieved)} of the time`);
if (clean < 1) failures.push(`fabricated numbers appeared in ${pct(1 - clean)} of drafts`);
if (quoted < 0.67) failures.push(`the reused fact survived only ${pct(quoted)} of the time`);
if (withinLimit < 0.67) failures.push(`only ${pct(withinLimit)} respected the word limit`);

if (failures.length > 0) {
  console.error(`\nFAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nPASSED: drafts reuse prior work, stay in limit, and invent nothing.");
