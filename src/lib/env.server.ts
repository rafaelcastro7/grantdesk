import { z } from "zod";

/**
 * Server-side configuration, validated at first use.
 *
 * The predecessor lost a working afternoon to a stale service-role key that
 * failed as a silent 401 in 91 call sites, and to documentation that claimed a
 * backend the code was not talking to. Config is therefore parsed, not read:
 * a missing or malformed value fails here, once, with the variable's name.
 */
const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  /**
   * Optional: the local floor. Unset on a hosted deployment (Lovable), where
   * no Ollama exists — the LLM chain then ends at the last cloud provider
   * and embeddings come from EMBED_API_URL instead.
   */
  OLLAMA_BASE_URL: z.string().url().optional(),
  OLLAMA_EMBED_MODEL: z.string().default("bge-m3"),
  /**
   * Hosted embeddings, OpenAI-compatible (/embeddings). Must serve the same
   * models as the stored vectors — BAAI/bge-m3 (1024d) for the catalog and
   * nomic-embed-text v1.5 (768d) for answers — or search compares vectors
   * from different spaces and returns confident nonsense. DeepInfra serves
   * both at https://api.deepinfra.com/v1/openai
   */
  EMBED_API_URL: z.string().url().optional(),
  EMBED_API_KEY: z.string().optional(),
  EMBED_API_MODEL_CATALOG: z.string().default("BAAI/bge-m3"),
  EMBED_API_MODEL_ANSWERS: z.string().default("nomic-ai/nomic-embed-text-v1.5"),
  /**
   * The local floor. Configurable because which model is best here is a
   * measurement (`bun run benchmark:local`) rather than a constant, and it was
   * hardcoded in two places that could disagree.
   *
   * gemma4:e2b-it-qat, chosen on measurement rather than size. Asked for a
   * section needing a fact nobody supplied, three runs each:
   *
   *   phi4-mini    invented staff in 3/3 — "John Smith, MBA, 10 years"
   *   qwen3.5:2b   invented staff in 3/3 — "Dr. Elena Rossi, fifteen years"
   *   gemma4:e2b   wrote [NEED: Name of staff and their qualifications], 3/3
   *
   * It is also twice the speed of the model it replaces: 8.8 tok/s against
   * 4.6, a 250-word section in about 40 seconds rather than 76. But the reason
   * is the first table. A fallback that invents a named person with invented
   * credentials, into a document a funder reads, is worse than no fallback.
   */
  OLLAMA_CHAT_MODEL: z.string().default("gemma4:e2b-it-qat"),
  CEREBRAS_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GOOGLE_AI_STUDIO_KEY: z.string().optional(),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  // Lovable Cloud names the Supabase variables differently (VITE_… and
  // *_PUBLISHABLE_KEY); accept either spelling rather than requiring renames.
  const env = process.env;
  const parsed = schema.safeParse({
    ...env,
    SUPABASE_URL: env.SUPABASE_URL ?? env.VITE_SUPABASE_URL,
    SUPABASE_ANON_KEY:
      env.SUPABASE_ANON_KEY ??
      env.SUPABASE_PUBLISHABLE_KEY ??
      env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      env.VITE_SUPABASE_ANON_KEY,
  });
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `Invalid server environment: ${missing}. Copy .env.example to .env and fill it in.`,
    );
  }
  cached = parsed.data;
  return cached;
}
