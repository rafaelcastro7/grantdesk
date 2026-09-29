/**
 * Bring the catalog up to date, and leave it searchable.
 *
 * One command, safe to run every hour from any scheduler, that does nothing
 * when nothing is due. Each adapter declares how often it is worth re-reading
 * and this consults that, so the scheduler needs no configuration of its own
 * and a new source arrives with its own cadence rather than a cron entry
 * somebody has to remember to add.
 *
 * It embeds afterwards, and that is the point rather than a convenience.
 * Ingestion and embedding were two separate commands, so a freshly ingested
 * call was invisible to meaning-based search until someone ran the second one —
 * and the eval shows the vector side is what finds vocabulary gaps and
 * cross-language matches at all. The newest calls, the ones whose deadlines are
 * closest, were the least findable in the product.
 *
 * Usage:
 *   bun run refresh            # read whatever is due, then embed
 *   bun run refresh --force    # read everything now, ignoring cadence
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env" });

const { SOURCES, sourceByKey } = await import("../src/server/sources");
const { runSource } = await import("../src/server/ingest");
const { embedCatalog, embedPendingAnswers, EMBED_MODEL } = await import("../src/server/embed");
const { minutesUntilNextDue, sourcesDue } = await import("../src/lib/refresh-schedule");
const { runOutbox } = await import("../src/server/email-sender");

const force = process.argv.slice(2).includes("--force");

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// `source_freshness` reports the last *successful* run per source, which is the
// only honest basis for "when was this last read".
const { data: freshness, error } = await supabase
  .from("source_freshness")
  .select("source_key, last_ok_at");
if (error) {
  console.error(`Could not read source freshness: ${error.message}`);
  process.exit(1);
}

const lastOk = new Map(
  ((freshness ?? []) as Array<{ source_key: string; last_ok_at: string | null }>).map((row) => [
    row.source_key,
    row.last_ok_at ? new Date(row.last_ok_at) : null,
  ]),
);

const schedules = SOURCES.map((source) => ({
  key: source.key,
  cadenceHours: source.cadenceHours,
  lastOkAt: lastOk.get(source.key) ?? null,
}));

const now = new Date();
const due = force
  ? schedules.map((s) => ({ key: s.key, reason: "forced" }))
  : sourcesDue(schedules, now);

let failures = 0;
let ingested = 0;

if (due.length === 0) {
  const wait = minutesUntilNextDue(schedules, now);
  // Said out loud, because a scheduled run that prints nothing is
  // indistinguishable from one that is silently broken, and the difference
  // matters at three in the morning.
  console.log(
    wait === null
      ? "Nothing due, and nothing scheduled."
      : `Nothing due. Next source in ${wait < 60 ? `${wait}m` : `${Math.round(wait / 60)}h`}.`,
  );
} else {
  for (const item of due) {
    const adapter = sourceByKey(item.key);
    if (!adapter) continue;
    process.stdout.write(`${item.key} (${item.reason}) ... `);
    try {
      const result = await runSource(adapter);
      ingested += result.grantsUpserted;
      console.log(
        `ok  ${result.grantsUpserted} grants, ${Math.round(result.durationMs / 1000)}s` +
          (result.skippedWithoutFunder ? `, ${result.skippedWithoutFunder} skipped` : ""),
      );
    } catch (caught) {
      failures++;
      // Recorded in source_runs by runSource itself, so the coverage page stops
      // claiming this market is fresh. Printed here for whoever reads the log.
      console.log(`FAILED  ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
}

// Always, even when nothing was ingested: a previous run may have been
// interrupted, or an answer may have been saved while the embedder was down.
// Both are cheap to check and expensive to leave.
process.stdout.write(`embedding with ${EMBED_MODEL} ... `);
try {
  const result = await embedCatalog(supabase);
  const answers = await embedPendingAnswers(supabase);
  console.log(
    `ok  ${result.embedded} embedded, ${result.unchanged} unchanged` +
      (answers.embedded > 0 ? `, ${answers.embedded} answer(s) recovered` : ""),
  );
} catch (caught) {
  failures++;
  console.log(`FAILED  ${caught instanceof Error ? caught.message : String(caught)}`);
  console.error("  Meaning-based search will be stale for anything new. Is Ollama running?");
}

// Last, so anything queued by this run goes out with it.
try {
  const sent = await runOutbox(supabase);
  if (sent && sent.failed > 0) failures++;
} catch (caught) {
  failures++;
  console.log(`email FAILED  ${caught instanceof Error ? caught.message : String(caught)}`);
}

if (ingested > 0 || failures > 0) {
  console.log(`\n${ingested} grants ingested, ${failures} failure(s).`);
}
process.exit(failures === 0 ? 0 : 1);
