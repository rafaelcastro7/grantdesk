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
      models: {
        extract: "llama-3.1-8b-instant",
        judge: "llama-3.3-70b-versatile",
        write: "llama-3.3-70b-versatile",
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

  return { text, provider: provider.name, model, latencyMs: Date.now() - started };
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
  return { text, provider: "ollama", model: "phi4-mini", latencyMs: Date.now() - started };
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
    try {
      const result = await callProvider(provider, request, timeoutMs);
      if (request.validate && !request.validate(result.text)) {
        attempts.push(`${provider.name}: failed caller validation`);
        continue;
      }
      return result;
    } catch (error) {
      attempts.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const result = await callOllama(request, timeoutMs);
    if (!request.validate || request.validate(result.text)) return result;
    attempts.push("ollama: failed caller validation");
  } catch (error) {
    attempts.push(`ollama: ${error instanceof Error ? error.message : String(error)}`);
  }

  throw new LlmUnavailableError(attempts);
}
