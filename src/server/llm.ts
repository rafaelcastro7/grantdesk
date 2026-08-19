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
};

function providers(): Provider[] {
  const env = serverEnv();
  return [
    {
      name: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: env.GROQ_API_KEY,
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

/** Volume work leads with the fastest provider; judgement leads with the largest. */
function order(role: Role): Provider["name"][] {
  return role === "extract" ? ["cerebras", "groq", "gemini"] : ["groq", "cerebras", "gemini"];
}

async function callProvider(
  provider: Provider,
  request: LlmRequest,
  timeoutMs: number,
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
      // Groq rejects response_format outright unless the word "json" appears
      // somewhere in the messages — a 400 that says so plainly, but only if
      // anyone reads it. Every caller here already asks for JSON in words, and
      // this asserts it rather than hoping.
      ...(request.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
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
  const response = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "phi4-mini",
      messages: request.messages,
      stream: false,
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
    model: "phi4-mini",
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
  if (RATE_LIMITED.test(message)) return 2;
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

export async function callLlm(
  request: LlmRequest,
  options: { timeoutMs?: number } = {},
): Promise<LlmResponse> {
  const timeoutMs = options.timeoutMs ?? 60_000;
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
    try {
      const result = await callProvider(provider, request, timeoutMs);
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
    const result = await callOllama(request, timeoutMs);
    if (!request.validate || request.validate(result.text)) return { ...result, attempts };
    attempts.push("ollama: failed caller validation");
  } catch (error) {
    attempts.push(`ollama: ${error instanceof Error ? error.message : String(error)}`);
  }

  throw new LlmUnavailableError(attempts);
}
