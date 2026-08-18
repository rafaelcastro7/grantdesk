/**
 * Does hybrid retrieval actually beat keyword search on our own data?
 *
 * The predecessor never asked. It shipped a LIKE scan, called the result a
 * match, and the only evidence it worked was that rows came back. This eval
 * exists so that claim is a number rather than an assumption, and so a future
 * change to retrieval has to argue with a measurement.
 *
 * Two arms over the same labelled corpus (tests/evals/fixtures):
 *   BASELINE — `ilike` over titles and summaries, OR across the profile's
 *              sectors. This is the predecessor's approach, reproduced
 *              faithfully so the comparison is fair.
 *   HYBRID   — the shipped `search_grants`: tsvector + pgvector, fused by RRF.
 *
 * Reported per profile and overall: precision@5, recall, and how many of the
 * deliberate lexical traps each arm let through. The traps matter most — they
 * are the false positives that teach a consultant to stop trusting the page.
 *
 * One caveat, stated rather than hidden: the corpus is loaded into the live
 * catalog and each arm's candidate pool is capped before results are filtered
 * back down to it, so which *non-relevant* rows reach the top five shifts as
 * the surrounding catalog grows. Precision and recall have been stable across
 * runs; the trap count has moved (1 to 3 for the hybrid arm after a
 * re-ingestion). The comparison stays sound because both arms face the same
 * catalog in the same run, but the absolute numbers are not a fixed benchmark.
 *
 * Usage: bun run eval:match
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  EVAL_GRANTS,
  EVAL_PROFILES,
  EVAL_SOURCE_KEY,
  relevantCount,
  type EvalProfile,
} from "./fixtures/retrieval-corpus";

config({ path: ".env" });

const { embed, embedOne, contentHash } = await import("../../src/server/embed");
const { sourceHash } = await import("../../src/server/ingest");
const { lexicalQuery, semanticQuery } = await import("../../src/lib/match-query");

const K = 5;

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Load the corpus ─────────────────────────────────────────────────────────
// Into the real database, under its own source key, so retrieval runs against
// exactly the code path the product uses — including the generated tsvector
// column and the HNSW index. An in-memory reimplementation would measure a
// reimplementation.

async function loadCorpus(): Promise<Map<string, string>> {
  const { data: funder, error: funderError } = await supabase
    .from("funders")
    .upsert(
      {
        name: "Evaluation Fixture Funder",
        country: "CA",
        category: "eval fixture",
        source_key: EVAL_SOURCE_KEY,
      },
      { onConflict: "name,country" },
    )
    .select("id")
    .single();
  if (funderError) throw new Error(`could not create the fixture funder: ${funderError.message}`);

  const { error } = await supabase.from("grants").upsert(
    EVAL_GRANTS.map((g) => ({
      funder_id: (funder as { id: string }).id,
      title: g.title,
      summary: g.summary,
      url: `https://example.org/eval/${g.externalId}`,
      country: g.country,
      language: "en",
      status: "open",
      source_key: EVAL_SOURCE_KEY,
      source_hash: sourceHash(EVAL_SOURCE_KEY, g.externalId),
      last_seen_at: new Date().toISOString(),
    })),
    { onConflict: "source_hash" },
  );
  if (error) throw new Error(`could not load the fixture corpus: ${error.message}`);

  const { data: rows } = await supabase
    .from("grants")
    .select("id, source_hash")
    .eq("source_key", EVAL_SOURCE_KEY);

  const byHash = new Map(
    ((rows ?? []) as Array<{ id: string; source_hash: string }>).map((r) => [r.source_hash, r.id]),
  );

  const ids = new Map<string, string>();
  for (const g of EVAL_GRANTS) {
    const id = byHash.get(sourceHash(EVAL_SOURCE_KEY, g.externalId));
    if (id) ids.set(id, g.externalId);
  }
  if (ids.size !== EVAL_GRANTS.length) {
    throw new Error(`loaded ${ids.size} of ${EVAL_GRANTS.length} fixture grants`);
  }

  // Embed them, or the hybrid arm is silently just the baseline.
  const texts = EVAL_GRANTS.map((g) => `${g.title}\n\n${g.summary}`);
  const vectors = await embed(texts);
  const idByExternal = new Map([...ids].map(([id, ext]) => [ext, id]));
  const { error: embedError } = await supabase.from("grant_embeddings").upsert(
    EVAL_GRANTS.map((g, i) => ({
      grant_id: idByExternal.get(g.externalId)!,
      embedding: JSON.stringify(vectors[i]),
      content_hash: contentHash(texts[i]!),
      model: "nomic-embed-text",
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "grant_id" },
  );
  if (embedError) throw new Error(`could not embed the fixture corpus: ${embedError.message}`);

  return ids;
}

// ── The two arms ────────────────────────────────────────────────────────────

/** The predecessor's search, reproduced: substring matching, OR across sectors. */
async function baseline(profile: EvalProfile, corpus: Set<string>): Promise<string[]> {
  const terms = profile.sectors.map((s) => s.replace(/[-_]+/g, " "));
  const filter = terms
    .flatMap((term) => [`title.ilike.%${term}%`, `summary.ilike.%${term}%`])
    .join(",");

  const { data, error } = await supabase
    .from("grants")
    .select("id")
    .eq("status", "open")
    .or(filter)
    .limit(200);
  if (error) throw new Error(`baseline retrieval failed: ${error.message}`);

  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id).filter((id) => corpus.has(id));
}

async function hybrid(profile: EvalProfile, corpus: Set<string>): Promise<string[]> {
  const embedding = await embedOne(semanticQuery(profile));
  const { data, error } = await supabase.rpc("search_grants", {
    q: lexicalQuery(profile) || null,
    q_embedding: JSON.stringify(embedding),
    q_language: "en",
    countries: null,
    pool: 500,
    result_limit: 500,
  });
  if (error) throw new Error(`hybrid retrieval failed: ${error.message}`);

  return ((data ?? []) as Array<{ grant_id: string }>)
    .map((r) => r.grant_id)
    .filter((id) => corpus.has(id));
}

// ── Scoring ─────────────────────────────────────────────────────────────────

type Score = { precisionAtK: number; recall: number; trapsInTopK: number; found: number };

function score(ranked: string[], profileKey: string, externalOf: Map<string, string>): Score {
  const grantOf = new Map(EVAL_GRANTS.map((g) => [g.externalId, g]));
  const labelled = ranked.map((id) => grantOf.get(externalOf.get(id) ?? "")).filter(Boolean);

  const topK = labelled.slice(0, K);
  const hits = topK.filter((g) => g!.relevantTo.includes(profileKey)).length;
  const traps = topK.filter(
    (g) => g!.role === "lexical-trap" && !g!.relevantTo.includes(profileKey),
  ).length;
  const total = relevantCount(profileKey);
  const foundAll = labelled.filter((g) => g!.relevantTo.includes(profileKey)).length;

  return {
    precisionAtK: topK.length === 0 ? 0 : hits / topK.length,
    recall: total === 0 ? 0 : foundAll / total,
    trapsInTopK: traps,
    found: labelled.length,
  };
}

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;

// ── Run ─────────────────────────────────────────────────────────────────────

console.log("Loading the labelled corpus…");
const externalOf = await loadCorpus();
const corpus = new Set(externalOf.keys());
console.log(`${corpus.size} grants, ${EVAL_PROFILES.length} profiles\n`);

const rows: Array<{ profile: string; arm: string; score: Score }> = [];

for (const profile of EVAL_PROFILES) {
  rows.push({
    profile: profile.key,
    arm: "baseline",
    score: score(await baseline(profile, corpus), profile.key, externalOf),
  });
  rows.push({
    profile: profile.key,
    arm: "hybrid",
    score: score(await hybrid(profile, corpus), profile.key, externalOf),
  });
}

console.log("profile        arm       P@5    recall  traps@5");
console.log("─".repeat(52));
for (const row of rows) {
  console.log(
    `${row.profile.padEnd(14)} ${row.arm.padEnd(9)} ${pct(row.score.precisionAtK).padStart(4)}   ` +
      `${pct(row.score.recall).padStart(5)}   ${row.score.trapsInTopK}`,
  );
}

const mean = (arm: string, pick: (s: Score) => number) => {
  const picked = rows.filter((r) => r.arm === arm).map((r) => pick(r.score));
  return picked.reduce((a, b) => a + b, 0) / picked.length;
};

const baselineP = mean("baseline", (s) => s.precisionAtK);
const hybridP = mean("hybrid", (s) => s.precisionAtK);
const baselineR = mean("baseline", (s) => s.recall);
const hybridR = mean("hybrid", (s) => s.recall);
const baselineTraps = rows
  .filter((r) => r.arm === "baseline")
  .reduce((a, r) => a + r.score.trapsInTopK, 0);
const hybridTraps = rows
  .filter((r) => r.arm === "hybrid")
  .reduce((a, r) => a + r.score.trapsInTopK, 0);

console.log("─".repeat(52));
console.log(
  `baseline       mean      ${pct(baselineP).padStart(4)}   ${pct(baselineR).padStart(5)}   ${baselineTraps}`,
);
console.log(
  `hybrid         mean      ${pct(hybridP).padStart(4)}   ${pct(hybridR).padStart(5)}   ${hybridTraps}`,
);

// Stated because it is the difference between "60% is mediocre" and "60% is
// every relevant document, ranked above every trap". Each profile has fewer
// than K relevant grants, so P@K cannot reach 1.0 by construction.
const ceiling =
  EVAL_PROFILES.map((p) => Math.min(relevantCount(p.key), K) / K).reduce((a, b) => a + b, 0) /
  EVAL_PROFILES.length;
console.log(
  `(P@${K} ceiling on this corpus is ${pct(ceiling)} — there are only ${relevantCount(EVAL_PROFILES[0]!.key)} relevant grants per profile.)`,
);

// The gate. Hybrid retrieval costs an embedding model, an index and a fusion
// function; if it does not beat a substring scan on our own labelled data,
// that cost is not justified and this should fail loudly rather than be
// assumed to help.
const improvedPrecision = hybridP > baselineP;
const improvedRecall = hybridR > baselineR;
const noWorseOnTraps = hybridTraps <= baselineTraps;

console.log();
console.log(`precision improved: ${improvedPrecision ? "yes" : "NO"}`);
console.log(`recall improved:    ${improvedRecall ? "yes" : "NO"}`);
console.log(`traps no worse:     ${noWorseOnTraps ? "yes" : "NO"}`);

// Fixture rows are catalog rows; leaving them behind would inflate the
// coverage page with grants no funder ever published.
await supabase.from("grants").delete().eq("source_key", EVAL_SOURCE_KEY);
await supabase.from("funders").delete().eq("source_key", EVAL_SOURCE_KEY);

if (!improvedPrecision || !improvedRecall || !noWorseOnTraps) {
  console.error("\nFAILED: hybrid retrieval did not beat the keyword baseline.");
  process.exit(1);
}
console.log("\nPASSED: hybrid retrieval beats the keyword baseline on the labelled corpus.");
