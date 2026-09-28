import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { runDiscoveryCycle } from "../../scripts/daemon-continuous-discovery";
import { sourceHash } from "../../src/server/ingest";
import { businessBenefitsFinder } from "../../src/server/sources/business-benefits-finder";

const URL = process.env.SUPABASE_URL ?? "http://localhost:15535";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

beforeAll(() => {
  expect(SERVICE_KEY, "SUPABASE_SERVICE_ROLE_KEY required").not.toBe("");
});

describe("continuous 24/7 discovery & deduplication", () => {
  it("guarantees source_hash determinism with zero collisions across re-scans", () => {
    const hash1 = sourceHash("grantsGov", "OPP-12345");
    const hash2 = sourceHash("grantsGov", "OPP-12345");
    const hashDifferent = sourceHash("grantsGov", "OPP-67890");

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hashDifferent);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("runs discovery cycle idempotently without creating duplicate grants", async () => {
    // Run discovery cycle with single fast source and limit 10
    const cycle1 = await runDiscoveryCycle({
      sources: [businessBenefitsFinder],
      skipEmbedding: true,
      skipAlerts: true,
      limit: 10,
    });
    expect(cycle1.sourcesRun).toBe(1);

    // Count grants after first run
    const { count: countAfterFirst } = await admin
      .from("grants")
      .select("id", { count: "exact", head: true });

    // Second run with the identical source and records
    await runDiscoveryCycle({
      sources: [businessBenefitsFinder],
      skipEmbedding: true,
      skipAlerts: true,
      limit: 10,
    });
    const { count: countAfterSecond } = await admin
      .from("grants")
      .select("id", { count: "exact", head: true });

    // Verify: Grant count does not grow redundantly on second identical run
    expect(countAfterSecond).toBe(countAfterFirst);
  }, 30_000);
});
