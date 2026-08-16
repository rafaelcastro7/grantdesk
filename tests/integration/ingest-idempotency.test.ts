import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { runSource } from "../../src/server/ingest";
import { sourceHash } from "../../src/server/ingest";
import type { SourceAdapter } from "../../src/server/sources";

/**
 * Ingestion has to be safe to schedule, which means running it twice must not
 * duplicate the catalog. Proven against the real database with a fake adapter:
 * the network is not the thing under test here, the upsert conflict target is.
 */

const URL = process.env.SUPABASE_URL ?? "http://localhost:15535";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const stamp = Date.now();
const SOURCE_KEY = `test-source-${stamp}`;

const fixture: SourceAdapter = {
  key: SOURCE_KEY,
  label: "Test source",
  market: "CA",
  cadenceHours: 24,
  description: "Fixture used by the idempotency test.",
  harvest: async () => ({
    funders: [
      {
        name: `Test Funder ${stamp}`,
        country: "CA",
        jurisdiction: "CA-ON",
        category: "test",
        website: "https://example.org",
      },
    ],
    grants: [
      {
        funderName: `Test Funder ${stamp}`,
        funderCountry: "CA",
        title: "Test Program A",
        summary: "First program.",
        url: "https://example.org/a",
        country: "CA",
        currency: "CAD",
        externalId: "a",
      },
      {
        funderName: `Test Funder ${stamp}`,
        funderCountry: "CA",
        title: "Test Program B",
        summary: "Second program.",
        url: "https://example.org/b",
        country: "CA",
        currency: "CAD",
        externalId: "b",
      },
    ],
  }),
};

const admin = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const countGrants = async () => {
  const { count, error } = await admin
    .from("grants")
    .select("id", { count: "exact", head: true })
    .eq("source_key", SOURCE_KEY);
  if (error) throw new Error(error.message);
  return count ?? 0;
};

beforeAll(() => {
  expect(SERVICE_KEY, "SUPABASE_SERVICE_ROLE_KEY must be set — is .env loaded?").not.toBe("");
});

describe("running a source twice", () => {
  it("inserts the harvest the first time", async () => {
    const result = await runSource(fixture, { client: admin });
    expect(result.grantsUpserted).toBe(2);
    expect(result.skippedWithoutFunder).toBe(0);
    expect(await countGrants()).toBe(2);
  });

  it("updates in place rather than duplicating", async () => {
    await runSource(fixture, { client: admin });
    expect(await countGrants()).toBe(2);
  });

  it("keys rows on the source and its external id", () => {
    // Same id under a different source is a different row; the same pair is
    // the same row forever. This is the whole basis of idempotency.
    expect(sourceHash("a", "1")).toBe(sourceHash("a", "1"));
    expect(sourceHash("a", "1")).not.toBe(sourceHash("b", "1"));
  });

  it("records every run, so coverage can tell fresh from stale", async () => {
    const { data, error } = await admin
      .from("source_runs")
      .select("status, grants_upserted")
      .eq("source_key", SOURCE_KEY)
      .order("started_at", { ascending: false });
    if (error) throw new Error(error.message);
    expect(data!.length).toBeGreaterThanOrEqual(2);
    expect(data![0]!.status).toBe("ok");
  });

  it("records a failure instead of leaving the run open", async () => {
    // A source that fails silently would keep reporting its market as fresh,
    // which is the exact dishonesty this phase exists to prevent.
    const broken: SourceAdapter = {
      ...fixture,
      key: `${SOURCE_KEY}-broken`,
      harvest: async () => {
        throw new Error("upstream is down");
      },
    };
    await expect(runSource(broken, { client: admin })).rejects.toThrow("upstream is down");

    const { data } = await admin
      .from("source_runs")
      .select("status, error")
      .eq("source_key", `${SOURCE_KEY}-broken`)
      .single();
    expect(data!.status).toBe("failed");
    expect(data!.error).toContain("upstream is down");
  });
});
