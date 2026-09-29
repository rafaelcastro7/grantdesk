/**
 * 24/7 Continuous Grant Discovery & Notification Daemon
 *
 * Runs perpetually in the background:
 *   1. Harvesters read newly published grants across all configured sources
 *   2. Deduplication engine checks source_hash (zero duplicate records)
 *   3. Evaluates matches against client profiles and queues email notifications
 *   4. Scans deadlines and queues impending expiration reminders
 *   5. Embeds newly arrived grants into pgvector so semantic search is instantly up to date
 *
 * Usage:
 *   bun run scripts/daemon-continuous-discovery.ts            # runs continuous cycle
 *   bun run scripts/daemon-continuous-discovery.ts --once     # single run and exit
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { SOURCES, type SourceAdapter } from "../src/server/sources";
import { runSource } from "../src/server/ingest";
import { embedCatalog } from "../src/server/embed";
import { scanAndAlertNewGrants, scanAndAlertDeadlines } from "../src/server/notifications";
import { todayIn } from "../src/lib/deadline";

// Same precedence as the app: .env.local overrides .env per key.
config({ path: ".env.local" });
config({ path: ".env" });

const ONCE = process.argv.slice(2).includes("--once");
const INTERVAL_MINUTES = Number(process.env.DISCOVERY_INTERVAL_MINUTES) || 360; // default 6 hours

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function runDiscoveryCycle(
  options: {
    skipEmbedding?: boolean;
    limit?: number;
    sources?: SourceAdapter[];
    skipAlerts?: boolean;
  } = {},
): Promise<{
  sourcesRun: number;
  grantsUpserted: number;
  alertsQueued: number;
  deadlinesQueued: number;
  embedded: number;
}> {
  console.log(`[Discovery Daemon ${new Date().toISOString()}] Starting ingestion cycle...`);

  let totalGrantsUpserted = 0;
  let sourcesRun = 0;
  const newlyDiscoveredGrantIds: string[] = [];
  const activeSources = options.sources ?? SOURCES;
  // "New" means first seen during this cycle. last_seen_at moves on every
  // re-read, so keying on it re-alerted known grants every run.
  const cycleStarted = new Date().toISOString();

  for (const source of activeSources) {
    try {
      process.stdout.write(`Ingesting ${source.key} ... `);
      const result = await runSource(source, { client: supabase, limit: options.limit });
      totalGrantsUpserted += result.grantsUpserted;
      sourcesRun++;
      console.log(`ok (${result.grantsUpserted} upserted)`);
    } catch (err) {
      console.error(
        `FAILED source ${source.key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 1. Mark past-deadline grants as expired
  // Counted in Toronto time, like every other deadline in the product.
  const todayStr = todayIn();
  const { error: expireErr } = await supabase
    .from("grants")
    .update({ status: "expired" })
    .lt("deadline", todayStr)
    .eq("status", "open");
  if (expireErr) {
    console.warn(`[Discovery Daemon] Expire warning: ${expireErr.message}`);
  }

  let alertsQueued = 0;
  let deadlinesQueued = 0;

  if (!options.skipAlerts) {
    // 2. Fetch recently touched grants (seen today) for match alerts
    const { data: recentGrants, error: recentError } = await supabase
      .from("grants")
      .select("id")
      .gte("first_seen_at", cycleStarted)
      .eq("status", "open");
    if (recentError)
      console.error(`[Discovery Daemon] New-grant read failed: ${recentError.message}`);
    if (recentGrants) {
      newlyDiscoveredGrantIds.push(...recentGrants.map((g: { id: string }) => g.id));
    }

    // 3. Run notifications for new matches
    try {
      const res = await scanAndAlertNewGrants({ supabase, newGrantIds: newlyDiscoveredGrantIds });
      alertsQueued = res.queued;
      if (alertsQueued > 0) {
        console.log(`[Discovery Daemon] Queued ${alertsQueued} new grant email alerts.`);
      }
    } catch (err) {
      console.error(
        `[Discovery Daemon] Alert scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 4. Run deadline alerts
    try {
      const res = await scanAndAlertDeadlines({ supabase });
      deadlinesQueued = res.queued;
      if (deadlinesQueued > 0) {
        console.log(`[Discovery Daemon] Queued ${deadlinesQueued} deadline reminder alerts.`);
      }
    } catch (err) {
      console.error(
        `[Discovery Daemon] Deadline scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 5. Update vector embeddings so new grants are instantly searchable
  let embedded = 0;
  if (!options.skipEmbedding) {
    try {
      const embedRes = await embedCatalog(supabase);
      embedded = embedRes.embedded;
      console.log(`[Discovery Daemon] Embedded ${embedded} grants into pgvector.`);
    } catch (err) {
      console.error(
        `[Discovery Daemon] Embedding failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    `[Discovery Daemon ${new Date().toISOString()}] Cycle complete. Grants: ${totalGrantsUpserted}, Alerts: ${alertsQueued + deadlinesQueued}`,
  );

  return {
    sourcesRun,
    grantsUpserted: totalGrantsUpserted,
    alertsQueued,
    deadlinesQueued,
    embedded,
  };
}

if (import.meta.main || process.argv[1]?.includes("daemon-continuous-discovery")) {
  // Each cycle schedules the next only after it finishes: a fixed interval let
  // a slow cycle overlap the next one, and a rejection there went unhandled.
  const cycle = async () => {
    try {
      const result = await runDiscoveryCycle();
      if (result.sourcesRun < SOURCES.length) {
        console.error(`[Discovery Daemon] ${SOURCES.length - result.sourcesRun} source(s) failed.`);
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(
        `[Discovery Daemon] Cycle crashed: ${err instanceof Error ? err.message : err}`,
      );
      process.exitCode = 1;
    }
    if (!ONCE) {
      console.log(`[Discovery Daemon] Next run in ${INTERVAL_MINUTES} minutes.`);
      setTimeout(cycle, INTERVAL_MINUTES * 60 * 1000);
    }
  };
  await cycle();
}
