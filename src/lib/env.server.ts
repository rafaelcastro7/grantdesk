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
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_EMBED_MODEL: z.string().default("bge-m3"),
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
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `Invalid server environment: ${missing}. Copy .env.example to .env and fill it in.`,
    );
  }
  cached = parsed.data;
  return cached;
}
