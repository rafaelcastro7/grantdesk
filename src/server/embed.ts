import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env.server";

/**
 * Embeddings for the semantic half of retrieval.
 *
 * Local, via Ollama's bge-m3. Three reasons it is not a cloud
 * embedder: the catalog is tens of thousands of rows and re-embeds whenever a
 * funder edits a description, so per-token pricing would dominate the whole
 * system's cost; embedding a public grant notice needs no cloud judgement; and
 * a rate limit in the middle of a nightly re-embed leaves the index half
 * updated, which is worse than slower.
 *
 * Multilingual on purpose, and the reason this is bge-m3 rather than the
 * English nomic-embed-text it started as. The eval measured the difference on
 * a French call against an English profile: nomic separated relevant from
 * irrelevant by 0.084, bge-m3 by 0.226. A gap that small does not survive
 * thousands of English documents competing for the same ranking, which made
 * every French and Spanish call in the catalog reachable by exact wording
 * alone. See migration 0014 and ADR-0004.
 *
 * 1024 dimensions, matching the `vector(1024)` column. A model of a different
 * width cannot be swapped in without a migration, which is deliberate — a
 * silent width change would corrupt every distance in the table.
 */

export const EMBED_MODEL = "bge-m3";
export const EMBED_DIMENSIONS = 1024;

/**
 * A different model for the answer library, and the measurement that forced it.
 *
 * Retrieving grants and retrieving a consultant's own stored answers look like
 * the same problem and are not. Grants are long documents in four languages
 * where cross-language matching is the whole point. Answers are short English
 * passages, written by one person for one client, matched against a short
 * requirement heading — and bge-m3 is measurably bad at that:
 *
 *   query "Organizational Capacity. Demonstrate your ability to deliver..."
 *                                   bge-m3    nomic
 *     the client's track-record answer  0.4145   0.5852
 *     an unrelated budget note          0.5185   0.5945
 *     an unrelated safety policy        0.4877   0.5342
 *
 * Under bge-m3 the right answer sits below both wrong ones, at every phrasing
 * tried — label alone, detail alone, both. There is no threshold that fixes an
 * ordering. Under nomic the true match clears 0.55 and reuse works.
 *
 * Neither separates the budget note cleanly, and that label is arguable anyway:
 * a budget narrative does touch organizational capacity. What is not arguable
 * is that one model retrieves the consultant's own answer and the other does
 * not.
 *
 * The two spaces never meet: grant vectors are only ever compared to grant
 * queries, answer vectors only to requirement queries.
 */
export const ANSWER_EMBED_MODEL = "nomic-embed-text";
export const ANSWER_EMBED_DIMENSIONS = 768;

/** Rows per request. See the comment in embed() for why this is not larger. */
const EMBED_BATCH = 16;

/** Re-embedding unchanged text is the main avoidable cost, so content is hashed. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function embed(
  texts: string[],
  model: string = EMBED_MODEL,
  timeoutMs = 300_000,
): Promise<number[][]> {
  const env = serverEnv();
  const out: number[][] = [];

  // Ollama's /api/embed takes a batch, but a batch is one request with one
  // timeout — and grant descriptions run to 8000 characters, so a large batch
  // of real rows is a very different thing from a large batch of short ones.
  // Sixteen at a time, with a generous ceiling: the first full run under
  // bge-m3 died on a 32-row batch of real text while the same code had been
  // fine under a smaller, faster model.
  // Hosted (OpenAI-compatible) when configured — the only option on Lovable —
  // otherwise the local Ollama. Same model weights either way, so vectors
  // stored by one are comparable with queries embedded by the other.
  const hosted = env.EMBED_API_URL ? env.EMBED_API_URL.replace(/\/+$/, "") : null;
  if (!hosted && !env.OLLAMA_BASE_URL) {
    throw new Error(
      "No embedder configured: set EMBED_API_URL (+ EMBED_API_KEY) for a hosted one, or OLLAMA_BASE_URL for local.",
    );
  }
  const hostedModel =
    model === ANSWER_EMBED_MODEL ? env.EMBED_API_MODEL_ANSWERS : env.EMBED_API_MODEL_CATALOG;

  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const chunk = texts.slice(i, i + EMBED_BATCH);
    const response = hosted
      ? await fetch(`${hosted}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(env.EMBED_API_KEY ? { Authorization: `Bearer ${env.EMBED_API_KEY}` } : {}),
          },
          body: JSON.stringify({ model: hostedModel, input: chunk, encoding_format: "float" }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      : await fetch(`${env.OLLAMA_BASE_URL}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, input: chunk }),
          signal: AbortSignal.timeout(timeoutMs),
        });
    if (!response.ok) {
      throw new Error(
        `embedding failed: HTTP ${response.status} from ${hosted ?? env.OLLAMA_BASE_URL}`,
      );
    }
    const vectors = hosted
      ? (
          ((await response.json()) as { data?: Array<{ embedding: number[]; index?: number }> })
            .data ?? []
        )
          .slice()
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          .map((row) => row.embedding)
      : (((await response.json()) as { embeddings?: number[][] }).embeddings ?? []);
    if (vectors.length !== chunk.length) {
      throw new Error(`embedder returned ${vectors.length} vectors for ${chunk.length} inputs`);
    }
    const expected = model === ANSWER_EMBED_MODEL ? ANSWER_EMBED_DIMENSIONS : EMBED_DIMENSIONS;
    for (const vector of vectors) {
      if (vector.length !== expected) {
        throw new Error(
          `${model} returned ${vector.length} dimensions, but its column is ${expected}`,
        );
      }
      out.push(vector);
    }
  }

  return out;
}

/**
 * One short text, for a request a person is waiting on. Twenty seconds, not
 * the batch job's five minutes: a query embed that slow means the embedder is
 * down, and callers already degrade to word matching when this throws.
 */
export async function embedOne(text: string, model: string = EMBED_MODEL): Promise<number[]> {
  const [vector] = await embed([text], model, 20_000);
  if (!vector) throw new Error("the embedder returned no vector");
  return vector;
}

/** What a grant is embedded *as*. Kept in one place so the query side matches. */
export function grantText(grant: {
  title: string;
  summary?: string | null;
  eligibility_note?: string | null;
}): string {
  return [grant.title, grant.summary, grant.eligibility_note]
    .filter((part) => !!part && String(part).trim().length > 0)
    .join("\n\n")
    .slice(0, 8000);
}

async function readAll<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  max: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; out.length < max; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(`could not read for embedding: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out.slice(0, max);
}

export type EmbedCatalogResult = {
  considered: number;
  embedded: number;
  unchanged: number;
};

/**
 * Bring the embedding table up to date with the catalog.
 *
 * Only rows whose text actually changed are re-embedded, so a nightly run over
 * an unchanged catalog costs one query rather than a full pass.
 */
export async function embedCatalog(
  supabase: SupabaseClient,
  options: { limit?: number } = {},
): Promise<EmbedCatalogResult> {
  type GrantRow = {
    id: string;
    title: string;
    summary: string | null;
    eligibility_note: string | null;
  };
  // Paged and ordered: an unordered .limit() returns an arbitrary subset, and
  // a hosted row cap would silently leave the rest of the catalog unembedded.
  const rows = await readAll<GrantRow>(
    (from, to) =>
      supabase
        .from("grants")
        .select("id, title, summary, eligibility_note")
        // Forecasts stay findable: they are what a consultant plans ahead on.
        .in("status", ["open", "forecasted"])
        .order("id")
        .range(from, to),
    options.limit ?? 50_000,
  );

  // A failed read here used to look like "nothing embedded yet" and
  // re-embedded the entire catalog — an hour of CPU on this machine.
  const existing = await readAll<{ grant_id: string; content_hash: string }>(
    (from, to) =>
      supabase
        .from("grant_embeddings")
        .select("grant_id, content_hash")
        .order("grant_id")
        .range(from, to),
    Number.POSITIVE_INFINITY,
  );
  const known = new Map(existing.map((r) => [r.grant_id, r.content_hash]));

  const stale = rows
    .map((row) => ({ row, text: grantText(row), hash: contentHash(grantText(row)) }))
    .filter((item) => known.get(item.row.id) !== item.hash);

  let embedded = 0;
  for (let i = 0; i < stale.length; i += 64) {
    const batch = stale.slice(i, i + 64);
    const vectors = await embed(batch.map((item) => item.text));
    const { error: writeError } = await supabase.from("grant_embeddings").upsert(
      batch.map((item, index) => ({
        grant_id: item.row.id,
        embedding: JSON.stringify(vectors[index]),
        content_hash: item.hash,
        model: EMBED_MODEL,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "grant_id" },
    );
    if (writeError) throw new Error(`could not store embeddings: ${writeError.message}`);
    embedded += batch.length;
  }

  return { considered: rows.length, embedded, unchanged: rows.length - stale.length };
}

/**
 * Back-fill answers that were stored without an embedding.
 *
 * `saveAnswer` deliberately keeps a consultant's work even when the local
 * embedder is unreachable — losing what they wrote because a model was down
 * would be far worse. But nothing ever came back for those rows, so an answer
 * saved during one bad minute was silently excluded from reuse forever, and the
 * library quietly stopped being worth anything for that client.
 *
 * Run alongside the catalog embed; it is a no-op when there is nothing to fix.
 */
export async function embedPendingAnswers(supabase: SupabaseClient): Promise<{ embedded: number }> {
  const { data, error } = await supabase
    .from("answer_library")
    .select("id, label, content")
    .is("embedding", null)
    .limit(500);
  if (error) throw new Error(`could not read the answer library: ${error.message}`);

  const rows = (data ?? []) as Array<{ id: string; label: string; content: string }>;
  if (rows.length === 0) return { embedded: 0 };

  const texts = rows.map((row) => `${row.label}. ${row.content}`.slice(0, 4000));
  const vectors = await embed(texts, ANSWER_EMBED_MODEL);

  for (let i = 0; i < rows.length; i++) {
    const { error: writeError } = await supabase
      .from("answer_library")
      .update({
        embedding: JSON.stringify(vectors[i]),
        content_hash: contentHash(texts[i]!),
      })
      .eq("id", rows[i]!.id);
    if (writeError) throw new Error(`could not store an answer embedding: ${writeError.message}`);
  }

  return { embedded: rows.length };
}
