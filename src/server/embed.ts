import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env.server";

/**
 * Embeddings for the semantic half of retrieval.
 *
 * Local, via Ollama's nomic-embed-text. Three reasons it is not a cloud
 * embedder: the catalog is tens of thousands of rows and re-embeds whenever a
 * funder edits a description, so per-token pricing would dominate the whole
 * system's cost; embedding a public grant notice needs no cloud judgement; and
 * a rate limit in the middle of a nightly re-embed leaves the index half
 * updated, which is worse than slower.
 *
 * 768 dimensions, matching the `vector(768)` column. A model of a different
 * width cannot be swapped in without a migration, which is deliberate — a
 * silent width change would corrupt every distance in the table.
 */

export const EMBED_MODEL = "nomic-embed-text";
export const EMBED_DIMENSIONS = 768;

/** Re-embedding unchanged text is the main avoidable cost, so content is hashed. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function embed(texts: string[]): Promise<number[][]> {
  const env = serverEnv();
  const out: number[][] = [];

  // Ollama's /api/embed takes a batch, but a long batch is one long request
  // with one timeout; chunking keeps a single slow row from failing the rest.
  for (let i = 0; i < texts.length; i += 32) {
    const chunk = texts.slice(i, i + 32);
    const response = await fetch(`${env.OLLAMA_BASE_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: chunk }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`embedding failed: HTTP ${response.status} from ${env.OLLAMA_BASE_URL}`);
    }
    const body = (await response.json()) as { embeddings?: number[][] };
    const vectors = body.embeddings ?? [];
    if (vectors.length !== chunk.length) {
      throw new Error(`embedder returned ${vectors.length} vectors for ${chunk.length} inputs`);
    }
    for (const vector of vectors) {
      if (vector.length !== EMBED_DIMENSIONS) {
        throw new Error(
          `embedder returned ${vector.length} dimensions, but the column is ${EMBED_DIMENSIONS}`,
        );
      }
      out.push(vector);
    }
  }

  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
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
  const { data: grants, error } = await supabase
    .from("grants")
    .select("id, title, summary, eligibility_note")
    .eq("status", "open")
    .limit(options.limit ?? 5000);
  if (error) throw new Error(`could not read grants: ${error.message}`);

  const rows = (grants ?? []) as Array<{
    id: string;
    title: string;
    summary: string | null;
    eligibility_note: string | null;
  }>;

  const { data: existing } = await supabase
    .from("grant_embeddings")
    .select("grant_id, content_hash");
  const known = new Map(
    ((existing ?? []) as Array<{ grant_id: string; content_hash: string }>).map((r) => [
      r.grant_id,
      r.content_hash,
    ]),
  );

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
  const vectors = await embed(texts);

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
