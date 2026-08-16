/**
 * Run one source, or all of them.
 *
 * Usage:
 *   bun run ingest              # every registered source
 *   bun run ingest grants-gov   # one source
 *   bun run ingest --limit=50   # small run, for checking a change quickly
 */

import { config } from "dotenv";
import { SOURCES, sourceByKey } from "../src/server/sources";
import { runSource } from "../src/server/ingest";

config({ path: ".env" });

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
const keys = args.filter((a) => !a.startsWith("--"));

const selected = keys.length
  ? keys.map((key) => {
      const adapter = sourceByKey(key);
      if (!adapter) {
        console.error(`unknown source: ${key}`);
        console.error(`known: ${SOURCES.map((s) => s.key).join(", ")}`);
        process.exit(1);
      }
      return adapter;
    })
  : SOURCES;

let failures = 0;

for (const adapter of selected) {
  process.stdout.write(`${adapter.key} (${adapter.market}) ... `);
  try {
    const result = await runSource(adapter, { limit });
    console.log(
      `ok  ${result.grantsUpserted} grants, ${result.fundersUpserted} funders, ` +
        `${Math.round(result.durationMs / 1000)}s` +
        (result.skippedWithoutFunder ? `, ${result.skippedWithoutFunder} skipped` : ""),
    );
  } catch (error) {
    failures++;
    console.log(`FAILED  ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.exit(failures === 0 ? 0 : 1);
