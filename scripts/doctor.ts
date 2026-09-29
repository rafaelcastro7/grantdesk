/**
 * Is this system actually able to do its job right now?
 *
 * Written because it could not, for weeks, and nothing said so. Groq retired a
 * model and Cerebras ran out of quota; every call fell through to a small local
 * model, every screen reported an ordinary success, and the only reason it was
 * ever noticed was an eval that happened to print which provider answered.
 *
 * Each check states what is wrong in terms of what to do about it, and the
 * script exits non-zero when something is genuinely broken rather than merely
 * degraded — a check that cries wolf gets run with `|| true` within a week.
 *
 * Usage: bun run doctor
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env" });

const { callLlm } = await import("../src/server/llm");
const { serverEnv } = await import("../src/lib/env.server");
const { embedOne, EMBED_MODEL, ANSWER_EMBED_MODEL, EMBED_DIMENSIONS, ANSWER_EMBED_DIMENSIONS } =
  await import("../src/server/embed");

type Verdict = "ok" | "degraded" | "broken";

type Check = { name: string; verdict: Verdict; detail: string };

const checks: Check[] = [];
const record = (name: string, verdict: Verdict, detail: string) => {
  checks.push({ name, verdict, detail });
  const mark = verdict === "ok" ? "ok " : verdict === "degraded" ? "!! " : "XX ";
  console.log(`${mark} ${name.padEnd(28)} ${detail}`);
};

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── The database ────────────────────────────────────────────────────────────
try {
  const { count, error } = await supabase
    .from("grants")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");
  if (error) throw new Error(error.message);
  record("database", "ok", `reachable, ${count ?? 0} open calls`);
} catch (error) {
  record(
    "database",
    "broken",
    `${error instanceof Error ? error.message : String(error)}
     Is the stack up? bun run db:up && bun run db:migrate`,
  );
}

// ── Retrieval's two halves ──────────────────────────────────────────────────
// A catalog with no embeddings still returns results, from the lexical side
// alone — quietly worse, and indistinguishable from a healthy run without this.
try {
  const [{ count: grants }, { count: embedded }] = await Promise.all([
    supabase.from("grants").select("id", { count: "exact", head: true }).eq("status", "open"),
    supabase.from("grant_embeddings").select("grant_id", { count: "exact", head: true }),
  ]);
  const total = grants ?? 0;
  const have = embedded ?? 0;
  const coverage = total === 0 ? 1 : have / total;
  if (coverage >= 0.98) record("grant embeddings", "ok", `${have}/${total} embedded`);
  else if (coverage >= 0.5)
    record("grant embeddings", "degraded", `only ${have}/${total} embedded — run: bun run embed`);
  else
    record(
      "grant embeddings",
      "broken",
      `${have}/${total} embedded; meaning-based search is effectively off. Run: bun run embed`,
    );
} catch (error) {
  record("grant embeddings", "broken", error instanceof Error ? error.message : String(error));
}

// ── The two embedders ───────────────────────────────────────────────────────
// Two models on purpose (see src/server/embed.ts). Both are checked, and the
// width is asserted: a model swapped underneath us returns vectors that fit no
// column and every distance in the table becomes meaningless.
for (const [model, width, purpose] of [
  [EMBED_MODEL, EMBED_DIMENSIONS, "grants, multilingual"],
  [ANSWER_EMBED_MODEL, ANSWER_EMBED_DIMENSIONS, "answer reuse"],
] as const) {
  try {
    const vector = await embedOne("A short probe.", model);
    if (vector.length !== width) {
      record(
        `embedder ${model}`,
        "broken",
        `returned ${vector.length} dimensions, but its column is ${width}`,
      );
    } else {
      record(`embedder ${model}`, "ok", `${width}d, for ${purpose}`);
    }
  } catch (error) {
    record(
      `embedder ${model}`,
      "broken",
      `${error instanceof Error ? error.message : String(error)}
     Is Ollama running? ollama pull ${model}`,
    );
  }
}

// ── The local floor ─────────────────────────────────────────────────────────
// Checked for the same reason the embedders are: it is what runs when
// everything hosted is unreachable, and a floor that is not installed is a
// chain with no bottom. This check did not exist while the model was
// hardcoded, and the default has since changed — a fresh machine would fail
// every fallback with nothing here saying why.
//
// Non-empty content is asserted, not just a 200. Every current small model
// reasons by default and will otherwise return empty `content` with its whole
// budget spent in `thinking`, which callLlm reads as a failed provider.
try {
  const localEnv = serverEnv();
  // A hosted deployment has no floor by design; say so instead of "broken".
  if (!localEnv.OLLAMA_BASE_URL) throw new Error("__no_floor__");
  const response = await fetch(`${localEnv.OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: localEnv.OLLAMA_CHAT_MODEL,
      messages: [{ role: "user", content: "Say OK." }],
      stream: false,
      think: false,
      keep_alive: "30m",
      options: { num_predict: 40 },
    }),
    signal: AbortSignal.timeout(180_000),
  });

  const body = (await response.json()) as {
    message?: { content?: string; thinking?: string };
    eval_count?: number;
    eval_duration?: number;
    error?: string;
  };

  const label = `local floor ${localEnv.OLLAMA_CHAT_MODEL}`;
  if (body.error) {
    record(
      label,
      "broken",
      `${body.error.slice(0, 80)} — ollama pull ${localEnv.OLLAMA_CHAT_MODEL}`,
    );
  } else if (!(body.message?.content ?? "").trim()) {
    record(
      label,
      "broken",
      `empty content${body.message?.thinking ? ", budget spent thinking" : ""} — the fallback would return nothing`,
    );
  } else {
    const perSecond = (body.eval_count ?? 0) / ((body.eval_duration ?? 1) / 1e9);
    record(
      label,
      "ok",
      `${perSecond.toFixed(1)} tok/s — a 250-word section in ~${Math.round(350 / Math.max(perSecond, 0.1))}s`,
    );
  }
} catch (error) {
  if (error instanceof Error && error.message === "__no_floor__") {
    record("local floor", "degraded", "OLLAMA_BASE_URL unset (hosted): no local fallback");
  } else {
    record(
      "local floor",
      "broken",
      `${error instanceof Error ? error.message : String(error)} — is Ollama running?`,
    );
  }
}

// ── The provider chain, per role ────────────────────────────────────────────
// Probed with a real call, not a models listing. Listing a model is not
// evidence it can be called: that is exactly how the retired one went
// unnoticed. JSON mode is probed separately because a provider can answer in
// one and return an empty 200 in the other.
for (const [role, json] of [
  ["extract", true],
  ["write", false],
  ["judge", false],
] as const) {
  const messages = json
    ? [
        { role: "system" as const, content: "Reply with a single JSON object and nothing else." },
        { role: "user" as const, content: 'Return {"ok":true}' },
      ]
    : [{ role: "user" as const, content: "Say OK." }];

  try {
    const response = await callLlm(
      { role, json, messages, maxTokens: 400, noWait: true },
      { timeoutMs: 20_000 },
    );
    const label = `${response.provider}/${response.model}`;
    if (response.provider === "ollama") {
      record(
        `llm: ${role}${json ? " (json)" : ""}`,
        "degraded",
        `fell through to the local floor — ${response.attempts.join(" ; ") || "no reason recorded"}`,
      );
    } else if (response.attempts.length > 0) {
      record(
        `llm: ${role}${json ? " (json)" : ""}`,
        "degraded",
        `${label} answered, but ${response.attempts.length} provider(s) failed first: ${response.attempts.join(" ; ")}`,
      );
    } else {
      record(`llm: ${role}${json ? " (json)" : ""}`, "ok", `${label} in ${response.latencyMs}ms`);
    }
  } catch (error) {
    record(
      `llm: ${role}${json ? " (json)" : ""}`,
      "broken",
      error instanceof Error ? error.message.slice(0, 300) : String(error),
    );
  }
}

// ── How much drafting is left today ─────────────────────────────────────────
// Providers meter per minute and per day, and only the per-minute figure is
// visible in the obvious place. A run once fell through to the local model on
// every call while the per-minute headers showed 7908 of 8000 tokens free —
// the *daily* allowance was spent, and reading the wrong meter cost a round of
// tuning a constraint that was not binding.
try {
  const env2 = serverEnv();
  if (!env2.GROQ_API_KEY) {
    record("daily token budget", "degraded", "no Groq key, so nothing to report");
  } else {
    const probe = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env2.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "user", content: "Hi" }],
        // Sized like a real draft, not like a ping. The first version asked
        // for 16 tokens, which fits in the 811 left of a spent daily
        // allowance — so the check reported a healthy budget while every
        // actual draft was falling through to the local model. A probe that
        // cannot fail the way the thing it checks fails is not a check.
        max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const body = probe.ok ? "" : (await probe.text()).slice(0, 200);
    const perMinute = probe.headers.get("x-ratelimit-remaining-tokens");
    const daily = /per day \(TPD\): Limit (\d+), Used (\d+)/.exec(body);

    if (daily) {
      const limit = Number(daily[1]);
      const used = Number(daily[2]);
      record(
        "daily token budget",
        "broken",
        `spent: ${used.toLocaleString()}/${limit.toLocaleString()} for today. Drafting runs on the local model until it resets.`,
      );
    } else if (!probe.ok) {
      record("daily token budget", "degraded", `HTTP ${probe.status}: ${body.slice(0, 90)}`);
    } else {
      // Roughly 650 tokens a draft with reasoning_effort low, so this is a
      // usable answer to "can I draft a proposal right now".
      const remaining = Number(perMinute ?? 0);
      record(
        "token budget",
        "ok",
        `${remaining.toLocaleString()} tokens this minute — about ${Math.floor(remaining / 650)} drafts`,
      );
    }
  }
} catch (error) {
  record("token budget", "degraded", error instanceof Error ? error.message : String(error));
}

// ── Catalog freshness ───────────────────────────────────────────────────────
// The coverage page already tells a consultant this. The operator needs it too,
// because a source that has been failing quietly is the one thing the product
// promises never to hide.
try {
  const { data } = await supabase
    .from("source_runs")
    .select("source_key, status, started_at, error")
    .order("started_at", { ascending: false })
    .limit(50);

  const latest = new Map<string, { status: string; started_at: string; error: string | null }>();
  for (const row of (data ?? []) as Array<{
    source_key: string;
    status: string;
    started_at: string;
    error: string | null;
  }>) {
    if (!latest.has(row.source_key)) latest.set(row.source_key, row);
  }

  const failing = [...latest.entries()].filter(([, run]) => run.status === "failed");
  if (latest.size === 0) {
    record("ingestion", "degraded", "no source has ever run — bun run ingest");
  } else if (failing.length > 0) {
    record(
      "ingestion",
      "degraded",
      `last run failed for ${failing.map(([key]) => key).join(", ")}: ${failing[0]![1].error ?? "no reason recorded"}`,
    );
  } else {
    const oldest = [...latest.values()].sort((a, b) =>
      a.started_at.localeCompare(b.started_at),
    )[0]!;
    const days = Math.floor((Date.now() - Date.parse(oldest.started_at)) / 86_400_000);
    record(
      "ingestion",
      days > 7 ? "degraded" : "ok",
      `${latest.size} source(s), oldest ${days}d old`,
    );
  }
} catch (error) {
  record("ingestion", "broken", error instanceof Error ? error.message : String(error));
}

// ── Email delivery ──────────────────────────────────────────────────────────
// Alerts queue whether or not anything sends them, so an outbox that only
// grows looks exactly like a quiet week from every screen.
try {
  const { emailConfig } = await import("../src/server/email-sender");
  const email = emailConfig(process.env);
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const { count, error } = await supabase
    .from("email_outbox")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .lt("created_at", hourAgo);
  if (error) throw new Error(error.message);
  const stuck = count ?? 0;
  if (!email.ok) {
    record("email", "degraded", `${email.reason}; ${stuck} pending row(s) older than 1h`);
  } else if (stuck > 0) {
    record(
      "email",
      "degraded",
      `${stuck} pending row(s) older than 1h — run: bun run scripts/send-outbox.ts`,
    );
  } else {
    record("email", "ok", "configured, nothing pending for over an hour");
  }
} catch (error) {
  record("email", "broken", error instanceof Error ? error.message : String(error));
}

// ── Verdict ─────────────────────────────────────────────────────────────────
const broken = checks.filter((c) => c.verdict === "broken");
const degraded = checks.filter((c) => c.verdict === "degraded");

console.log();
if (broken.length === 0 && degraded.length === 0) {
  console.log("Everything checked is working.");
  process.exit(0);
}
if (degraded.length > 0) {
  console.log(`Degraded: ${degraded.map((c) => c.name).join(", ")}`);
  console.log("  The product still runs, but not as the design intends. Worth fixing today.");
}
if (broken.length > 0) {
  console.log(`Broken: ${broken.map((c) => c.name).join(", ")}`);
  // Only a genuine break exits non-zero. A check that cries wolf over a
  // degraded-but-working system gets run with `|| true` within a week, and then
  // it catches nothing at all.
  process.exit(1);
}
process.exit(0);
