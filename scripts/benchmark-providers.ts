/**
 * Which provider should lead for which role, measured rather than assumed.
 *
 * The order in src/server/llm.ts carried a rationale — "volume work leads with
 * the fastest, judgement with the largest" — that was true about models which
 * no longer exist. Groq retired the one it named; Cerebras stopped answering
 * anything. A rationale about the wrong models is worse than none, because it
 * reads like a decision.
 *
 * This probes every configured provider on every role with a real,
 * representative call, several times, and prints what it found. It changes
 * nothing on its own: the output is evidence for a human editing `order()`,
 * with the date it was taken, so the next reader can see how stale it is.
 *
 * Usage: bun run benchmark
 */

import { config } from "dotenv";

config({ path: ".env" });

const { serverEnv } = await import("../src/lib/env.server");

const ROUNDS = 3;

type Role = "extract" | "judge" | "write";

/** Representative of what each role actually sends, not a "say OK" ping. */
const WORK: Record<
  Role,
  {
    json: boolean;
    messages: Array<{ role: "system" | "user"; content: string }>;
    maxTokens: number;
  }
> = {
  extract: {
    json: true,
    maxTokens: 2000,
    messages: [
      {
        role: "system",
        content:
          "You read a funding call and list what an applicant must provide. Reply with a single JSON object and nothing else.",
      },
      {
        role: "user",
        content:
          'Call text: "Applicants must submit a project description of no more than 500 words, audited financial statements, and two letters of support. Open to registered charities in Ontario." Return {"requirements":[...]} with label, kind and wordLimit for each.',
      },
    ],
  },
  judge: {
    json: false,
    maxTokens: 1600,
    messages: [
      {
        role: "user",
        content:
          "A grant call is open to registered charities in Ontario. The applicant is a nonprofit society in British Columbia. In two sentences, is this a plausible application?",
      },
    ],
  },
  write: {
    json: false,
    maxTokens: 2000,
    messages: [
      {
        role: "system",
        content:
          "You draft one section of a grant application. Use only the facts given. Plain prose, no preamble.",
      },
      {
        role: "user",
        content:
          "Requirement: Organizational Capacity, 150 words. Organization: a nonprofit restoring urban ravines since 2011, eleven completed projects, annual budget CAD 450,000. Write the section.",
      },
    ],
  },
};

type Candidate = { provider: string; baseUrl: string; apiKey?: string; model: string };

const env = serverEnv();
const CANDIDATES: Candidate[] = [
  {
    provider: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: env.GROQ_API_KEY,
    model: "openai/gpt-oss-120b",
  },
  {
    provider: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKey: env.CEREBRAS_API_KEY,
    model: "gemma-4-31b",
  },
  {
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: env.GOOGLE_AI_STUDIO_KEY,
    model: "gemini-2.5-flash",
  },
];

type Result = { ok: number; failed: number; latencies: number[]; lastError: string };

async function probe(candidate: Candidate, role: Role): Promise<Result> {
  const work = WORK[role];
  const result: Result = { ok: 0, failed: 0, latencies: [], lastError: "" };

  for (let round = 0; round < ROUNDS; round++) {
    const started = Date.now();
    try {
      const response = await fetch(`${candidate.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${candidate.apiKey}`,
        },
        body: JSON.stringify({
          model: candidate.model,
          messages: work.messages,
          temperature: 0.2,
          max_tokens: work.maxTokens,
          ...(work.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        result.failed++;
        result.lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 90)}`;
        continue;
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = body.choices?.[0]?.message?.content ?? "";

      // An empty 200 is the failure mode that made a larger model unusable in
      // the predecessor, and it counts as a failure here for the same reason:
      // the caller pays a full timeout and gets nothing.
      if (!text.trim()) {
        result.failed++;
        result.lastError = "empty 200";
        continue;
      }
      // JSON mode guarantees the shape, not the content. A response that does
      // not parse is a failure however cleanly it arrived.
      if (work.json) {
        try {
          JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
        } catch {
          result.failed++;
          result.lastError = "unparseable json";
          continue;
        }
      }

      result.ok++;
      result.latencies.push(Date.now() - started);
    } catch (error) {
      result.failed++;
      result.lastError = error instanceof Error ? error.message.slice(0, 90) : String(error);
    }
  }

  return result;
}

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

console.log(`Probing ${CANDIDATES.length} providers x 3 roles x ${ROUNDS} rounds.\n`);
console.log("role      provider    model                  ok    median    note");
console.log("─".repeat(78));

const findings: Array<{ role: Role; provider: string; ok: number; median: number }> = [];

for (const role of ["extract", "judge", "write"] as const) {
  for (const candidate of CANDIDATES) {
    if (!candidate.apiKey) {
      console.log(`${role.padEnd(9)} ${candidate.provider.padEnd(11)} ${"—".padEnd(22)} no key`);
      continue;
    }
    const result = await probe(candidate, role);
    const ms = median(result.latencies);
    findings.push({ role, provider: candidate.provider, ok: result.ok, median: ms });
    console.log(
      `${role.padEnd(9)} ${candidate.provider.padEnd(11)} ${candidate.model.slice(0, 21).padEnd(22)} ` +
        `${result.ok}/${ROUNDS}  ${(ms ? `${ms}ms` : "—").padStart(7)}   ${result.lastError}`,
    );
  }
}

console.log("\nSuggested order per role — every round answered, fastest first:");
for (const role of ["extract", "judge", "write"] as const) {
  const ranked = findings
    .filter((f) => f.role === role && f.ok === ROUNDS)
    .sort((a, b) => a.median - b.median)
    .map((f) => `"${f.provider}"`);
  const unreliable = findings
    .filter((f) => f.role === role && f.ok > 0 && f.ok < ROUNDS)
    .map((f) => `"${f.provider}"`);

  console.log(`  ${role.padEnd(8)} [${[...ranked, ...unreliable].join(", ")}]`);
}
console.log(
  `\nMeasured ${new Date().toISOString().slice(0, 10)}. Copy into order() in src/server/llm.ts,`,
);
console.log("with the date — a rationale about models that no longer exist reads like a decision.");
