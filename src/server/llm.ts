import { serverEnv } from "@/lib/env.server";

/**
 * Cloud LLM chain with a local floor.
 *
 * Order is per role, chosen from live measurement rather than reputation:
 * judgement and prose go to the largest model that answered reliably, while
 * high-volume extraction leads with the fastest. Every call still traverses the
 * whole chain, so one provider being down degrades quality rather than
 * breaking the feature.
 *
 * Two measured facts shape this file:
 *   - plain and JSON modes are not equivalent; a model can answer in one and
 *     return HTTP 200 with empty content in the other
 *   - listing a model in GET /models is not evidence it can be called
 */

export type Role = "extract" | "judge" | "write";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type LlmRequest = {
  role: Role;
  messages: ChatMessage[];
  /** Ask the provider to constrain sampling to a JSON object. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Reject a syntactically fine answer that fails the caller's own schema. */
  validate?: (text: string) => boolean;
  /**
   * Do not wait out a rate limit; report it instead.
   *
   * For callers that want the state rather than an answer. `doctor` set every
   * probe waiting twenty seconds on a provider it was checking *because* it
   * was rate-limited, and a health check that takes ten minutes to say
   * "degraded" is one nobody runs.
   */
  noWait?: boolean;
};

export type LlmResponse = {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
  /**
   * What was tried and why it failed, in order, before this answer.
   *
   * Empty on a healthy first-choice call. Non-empty means the chain degraded,
   * and without this nothing anywhere said so: Groq retired a model and
   * Cerebras ran out of quota, and the product ran on the local floor for
   * weeks while every screen reported a perfectly ordinary success.
   */
  attempts: string[];
};

type Provider = {
  name: "groq" | "cerebras" | "gemini";
  baseUrl: string;
  apiKey?: string;
  models: Record<Role, string>;
  /**
   * Accepts OpenAI's `reasoning_effort`. Sent only where it is known to be
   * understood: an unknown field is a 400 on some OpenAI-compatible gateways,
   * and trading a working provider for a cheaper one is a bad deal.
   */
  reasoningEffort?: boolean;
};

function providers(): Provider[] {
  const env = serverEnv();
  return [
    {
      name: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: env.GROQ_API_KEY,
      reasoningEffort: true,
      // The llama-3.x models this used to name were retired from this account
      // and answered 404 for weeks while the whole chain silently fell through
      // to the local floor. Probed live before being written down here:
      // gpt-oss-120b answers in both plain and JSON mode in ~430ms;
      // gpt-oss-20b returns an empty 200 in plain mode and 400s in JSON;
      // qwen3.6-27b leaks its <think> reasoning into the content.
      models: {
        extract: "openai/gpt-oss-120b",
        judge: "openai/gpt-oss-120b",
        write: "openai/gpt-oss-120b",
      },
    },
    {
      name: "cerebras",
      baseUrl: "https://api.cerebras.ai/v1",
      apiKey: env.CEREBRAS_API_KEY,
      // gemma-4-31b for every role: it is the only model on this account that
      // answered in both plain and JSON modes across repeated probes. The
      // larger gpt-oss-120b is inconsistent between them, and a model that
      // intermittently returns nothing is worse than a smaller one that always
      // answers — the caller pays a full timeout before falling through.
      // Measured 2026-08-19: this account returns 402 "payment required" for
      // every model. It stays in the chain because the failure is an account
      // state rather than a code one, and it costs one fast HTTP round trip to
      // find out it is back.
      models: { extract: "gemma-4-31b", judge: "gemma-4-31b", write: "gemma-4-31b" },
    },
    {
      name: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: env.GOOGLE_AI_STUDIO_KEY,
      // 2.0-* were retired; 2.5-pro and 2.5-flash-lite are listed but answer
      // 404 on this account. 2.5-flash is what actually responds.
      models: { extract: "gemini-2.5-flash", judge: "gemini-2.5-flash", write: "gemini-2.5-flash" },
    },
  ];
}

/**
 * Who to ask first, per role. Measured 2026-08-19 by `bun run benchmark`.
 *
 *   role      groq (gpt-oss-120b)   gemini (2.5-flash)   cerebras
 *   extract   3/3   943ms           3/3  1905ms          0/3, HTTP 402
 *   judge     3/3   475ms           3/3  4337ms          0/3, HTTP 402
 *   write     2/3  3984ms           3/3  5915ms          0/3, HTTP 402
 *
 * Groq leads everywhere: it answered every role and is two to nine times
 * faster. Its one miss on `write` was a 429 provoked by the benchmark itself
 * firing nine calls in seconds — a property of how it was measured, not of the
 * provider, and treating it as evidence would be over-fitting to my own load.
 *
 * Cerebras stays last rather than being removed: the failure is an account
 * state, not a code one, and the breaker skips it after the first refusal, so
 * it costs one round trip per half hour to discover it is back.
 *
 * The rationale this replaced — "volume work leads with the fastest, judgement
 * with the largest" — was true about models that no longer exist, which reads
 * like a decision while being none. Re-run the benchmark before trusting the
 * table above; the date is there so you can see how stale it is.
 */
function order(role: Role): Provider["name"][] {
  // Measured 2026-09-21 by `bun run benchmark`:
  //   role      groq (gpt-oss-120b)    gemini (2.5-flash)   cerebras (gemma-4-31b)
  //   extract   3/3   953ms            3/3   1841ms         0/3, HTTP 404 (archived)
  //   judge     3/3   412ms            3/3   4820ms         0/3, HTTP 404 (archived)
  //   write     3/3   2645ms           0/3   HTTP 429       0/3, HTTP 404 (archived)
  //
  // Groq leads everywhere. Cerebras stays last (account state, not code),
  // but Gemini write is unreliable on this account.
  switch (role) {
    case "extract":
    case "judge":
      return ["groq", "gemini", "cerebras"];
    case "write":
      return ["groq", "cerebras"];
  }
}

/**
 * How long a rate-limited provider says to wait, in milliseconds.
 *
 * Null when it does not say, or when the wait is long enough that falling
 * through to another provider is plainly better than blocking on this one.
 * Groq reports a token-bucket reset that is usually seconds; a minute-long
 * wait is a different situation and belongs to the next provider in the chain.
 */
const MAX_WAIT_MS = 20_000;

function retryAfterMs(headers: Headers): number | null {
  const candidates = [
    headers.get("retry-after"),
    headers.get("x-ratelimit-reset-tokens"),
    headers.get("x-ratelimit-reset-requests"),
  ].filter((value): value is string => !!value);

  for (const raw of candidates) {
    const ms = parseDuration(raw);
    if (ms !== null && ms <= MAX_WAIT_MS) return ms + 250;
  }
  return null;
}

/** "13.905s", "2m30s", or a bare number of seconds. */
export function parseDuration(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);

  const match = /^(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(trimmed);
  if (!match || (!match[1] && !match[2])) return null;
  const minutes = Number(match[1] ?? 0);
  const seconds = Number(match[2] ?? 0);
  return Math.round((minutes * 60 + seconds) * 1000);
}

async function callProvider(
  provider: Provider,
  request: LlmRequest,
  timeoutMs: number,
  retried = false,
  deadline?: number,
): Promise<LlmResponse> {
  const model = provider.models[request.role];
  const started = Date.now();

  if (request.json && !mentionsJson(request.messages)) {
    // Caught here rather than as a provider 400, because the fix is in the
    // prompt and the provider's message does not say which prompt.
    throw new Error(`${provider.name}_prompt_must_mention_json`);
  }

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: request.messages,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? 2048,
      // Measured on gpt-oss-120b, drafting a 250-word section: default effort
      // spends 1804 completion tokens, "low" spends 337 for the same 1900
      // characters of output. Groq bills the *requested* max_tokens against an
      // 8000/minute ceiling, so the difference is four drafts a minute versus
      // thirteen — the difference between a proposal that drafts and one that
      // falls through to the local model half way down.
      ...(provider.reasoningEffort ? { reasoning_effort: "low" } : {}),
      // Groq rejects response_format outright unless the word "json" appears
      // somewhere in the messages — a 400 that says so plainly, but only if
      // anyone reads it. Every caller here already asks for JSON in words, and
      // this asserts it rather than hoping.
      ...(request.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    // A 429 is not a failure, it is a "come back shortly", and the provider
    // says exactly how long. Falling through to a weaker model when waiting
    // fourteen seconds would produce the better answer is the wrong trade for
    // text a consultant reads word by word — and the measured token ceiling
    // here is 8000/minute, which a proposal of eight sections exceeds on its
    // own. Waited once, briefly, and only for this.
    if (response.status === 429 && !retried && !request.noWait) {
      const wait = retryAfterMs(response.headers);
      // Only if the wait fits inside what is left of this call's budget.
      if (wait !== null && (!deadline || Date.now() + wait + 5_000 < deadline)) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        const left = deadline ? Math.min(timeoutMs, deadline - Date.now()) : timeoutMs;
        return callProvider(provider, request, left, true, deadline);
      }
    }
    throw new Error(
      `${provider.name}_http_${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content ?? "";
  // An empty 200 is the specific failure that made a larger model unusable;
  // treat it as an error so the chain moves on instead of returning nothing.
  if (!text.trim()) throw new Error(`${provider.name}_empty_content`);

  return { text, provider: provider.name, model, latencyMs: Date.now() - started, attempts: [] };
}

async function callOllama(request: LlmRequest, timeoutMs: number): Promise<LlmResponse> {
  const env = serverEnv();
  const started = Date.now();
  // No floor on a hosted deployment; the chain reports every cloud attempt.
  if (!env.OLLAMA_BASE_URL) throw new Error("ollama_not_configured");
  const response = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.OLLAMA_CHAT_MODEL,
      messages: request.messages,
      stream: false,
      // Held resident between calls. Measured on this machine: a cold load
      // costs 6.9 seconds before the model says anything, a warm one 0.8 —
      // and Ollama unloads after five minutes idle, which is exactly the
      // rhythm of a consultant drafting one section at a time. Six seconds of
      // every fallback draft was the schedule, not the model.
      keep_alive: "30m",
      // Thinking off. Every current small model reasons by default and will
      // otherwise spend its whole budget doing it — measured on qwen3.5 and
      // gemma4: an empty `content`, 1800 characters of `thinking`, and
      // done_reason "length". `callLlm` reads `content`, so the fallback would
      // return nothing and the chain would report every provider as failed
      // without anything saying why.
      think: false,
      ...(request.json ? { format: "json" } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`ollama_http_${response.status}`);
  const body = (await response.json()) as { message?: { content?: string } };
  const text = body.message?.content ?? "";
  if (!text.trim()) throw new Error("ollama_empty_content");
  return {
    text,
    provider: "ollama",
    model: env.OLLAMA_CHAT_MODEL,
    latencyMs: Date.now() - started,
    attempts: [],
  };
}

/** Groq's requirement, checked before the request rather than after its 400. */
function mentionsJson(messages: ChatMessage[]): boolean {
  return messages.some((message) => /json/i.test(message.content));
}

/**
 * Stop asking a provider that has told us to stop asking.
 *
 * A 401 or 402 is an account state, not a blip: Cerebras answers "payment
 * required" to every call until someone visits the billing tab, and retrying it
 * first on every request buys a wasted round trip and nothing else. A 429 is
 * different in kind but the same in effect for the next little while.
 *
 * Deliberately in-process and short. This is a courtesy to the request path,
 * not a source of truth — `bun run doctor` always probes for real, so a
 * provider that has come back is found by the thing whose job that is rather
 * than by a cache someone has to remember to clear.
 */
const HARD_FAILURE = /_http_(401|402|403)/;
const RATE_LIMITED = /_http_429/;
/**
 * A 429 that will not clear for hours.
 *
 * Providers meter per minute *and* per day, and the two are told apart only by
 * the message. Groq's per-day exhaustion reads "on tokens per day (TPD): Limit
 * 200000, Used 199189" — retrying that every two minutes for the rest of the
 * day is a wasted round trip each time, and it hides the real reason behind a
 * rate-limit message that looks transient.
 *
 * Found by misreading it: the per-minute headers showed 7908 of 8000 tokens
 * free while every call fell through to the local model, and the pacing fix
 * that followed addressed a constraint that was not binding.
 */
const DAILY_EXHAUSTION = /per day|\bTPD\b|\bRPD\b|daily limit|check your plan and billing/i;
const RESTING: Map<string, number> = new Map();

/**
 * How long to leave a provider alone after this failure, in minutes.
 *
 * Exported because it is the whole decision, and the first version of it never
 * fired: the pattern ended in a literal backspace character rather than a word
 * boundary, so it matched nothing and every request kept paying a round trip to
 * a provider that had already said no. It looked correct in an editor. A test
 * is the only thing that would have caught it, so now there is one.
 */
export function restMinutesFor(message: string): number {
  if (HARD_FAILURE.test(message)) return 30;
  if (RATE_LIMITED.test(message)) return DAILY_EXHAUSTION.test(message) ? 60 : 2;
  return 0;
}

function restUntil(name: string, message: string): void {
  const minutes = restMinutesFor(message);
  if (minutes > 0) RESTING.set(name, Date.now() + minutes * 60_000);
}

function isResting(name: string): boolean {
  const until = RESTING.get(name);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  RESTING.delete(name);
  return false;
}

export class LlmUnavailableError extends Error {
  constructor(public readonly attempts: string[]) {
    super(`every provider failed: ${attempts.join("; ")}`);
    this.name = "LlmUnavailableError";
  }
}

/** Kept for the local model, so the floor always gets its turn. */
const OLLAMA_RESERVE_MS = 60_000;

export async function callLlm(
  request: LlmRequest,
  options: { timeoutMs?: number; overallMs?: number } = {},
): Promise<LlmResponse> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  // One budget for the whole chain. Per-attempt timeouts alone summed to
  // several minutes across three providers, a rate-limit wait each and the
  // local model — long past any browser or proxy giving up on the request.
  const deadline = Date.now() + (options.overallMs ?? timeoutMs * 2 + OLLAMA_RESERVE_MS);
  const cloudDeadline = deadline - OLLAMA_RESERVE_MS;
  const ranked = order(request.role);
  const chain = providers()
    .filter((p) => !!p.apiKey)
    .sort((a, b) => ranked.indexOf(a.name) - ranked.indexOf(b.name));

  const attempts: string[] = [];

  for (const provider of chain) {
    if (isResting(provider.name)) {
      attempts.push(`${provider.name}: skipped, still failing`);
      continue;
    }
    const left = cloudDeadline - Date.now();
    if (left < 5_000) {
      attempts.push(`${provider.name}: skipped, out of time`);
      continue;
    }
    try {
      const result = await callProvider(
        provider,
        request,
        Math.min(timeoutMs, left),
        false,
        cloudDeadline,
      );
      if (request.validate && !request.validate(result.text)) {
        attempts.push(`${provider.name}: failed caller validation`);
        continue;
      }
      return { ...result, attempts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      restUntil(provider.name, message);
      attempts.push(`${provider.name}: ${message}`);
    }
  }

  try {
    const result = await callOllama(
      request,
      Math.max(OLLAMA_RESERVE_MS, Math.min(timeoutMs, deadline - Date.now())),
    );
    if (!request.validate || request.validate(result.text)) return { ...result, attempts };
    attempts.push("ollama: failed caller validation");
  } catch (error) {
    attempts.push(`ollama: ${error instanceof Error ? error.message : String(error)}`);
  }

  throw new LlmUnavailableError(attempts);
}
