/**
 * Bring the embedding table up to date with the catalog.
 *
 * Runs after ingestion, and is cheap to run when nothing changed: rows are
 * keyed by a hash of the text that was embedded, so an unchanged catalog costs
 * two queries and no model calls.
 *
 * Usage:
 *   bun run embed
 *   bun run embed --limit=200
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env" });

const { embedCatalog, EMBED_MODEL } = await import("../src/server/embed");

const limitArg = process.argv.slice(2).find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

process.stdout.write(`embedding with ${EMBED_MODEL} ... `);
const started = Date.now();

try {
  const result = await embedCatalog(supabase, { limit });
  console.log(
    `ok  ${result.embedded} embedded, ${result.unchanged} unchanged, ` +
      `${result.considered} considered, ${Math.round((Date.now() - started) / 1000)}s`,
  );
} catch (error) {
  console.log(`FAILED  ${error instanceof Error ? error.message : String(error)}`);
  console.error("\nIs Ollama running, and has `ollama pull nomic-embed-text` been done?");
  process.exit(1);
}
