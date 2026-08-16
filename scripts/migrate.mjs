// Apply SQL migrations in order, once each, tracked in a table.
//
// Deliberately tiny and dependency-free: it shells out to psql inside the
// container rather than opening a Postgres connection, so it works before any
// client library is configured and cannot drift from what the database
// actually has.
//
// Usage: bun run db:migrate [--status]

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const CONTAINER = "grantdesk-db";
const STATUS_ONLY = process.argv.includes("--status");

function psql(sql) {
  return execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function psqlFile(sqlText) {
  execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { input: sqlText, stdio: ["pipe", "inherit", "inherit"], maxBuffer: 32 * 1024 * 1024 },
  );
}

psql(`create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
)`);

const applied = new Set(
  psql("select version from schema_migrations")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean),
);

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (STATUS_ONLY) {
  for (const file of files) {
    console.log(`${applied.has(file) ? "applied" : "PENDING"}  ${file}`);
  }
  process.exit(0);
}

let count = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  process.stdout.write(`applying ${file} ... `);
  psqlFile(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  psql(`insert into schema_migrations (version) values ('${file}')`);
  console.log("ok");
  count++;
}

// PostgREST caches the schema at boot. Applying migrations underneath it
// leaves that cache stale, and the symptom is a bare 404 on a table that
// plainly exists — which reads like a routing bug and is not one. Reload every
// time rather than leaving it as folklore for whoever hits it next.
if (count > 0) {
  psql("notify pgrst, 'reload schema'");
  console.log("postgrest schema cache reloaded");
}

console.log(count ? `${count} migration(s) applied` : "already up to date");
