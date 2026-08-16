import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env.server";
import { SOURCES } from "./sources";
import { coverageByMarket, type MarketCoverage, type SourceHealth } from "@/lib/coverage";

/**
 * What the catalog honestly contains, per market.
 *
 * Assembled from the source registry (what we claim to cover) joined against
 * the database (what actually landed and when). Neither half alone is
 * trustworthy: the registry describes intent, and row counts alone cannot tell
 * a healthy quiet source from a broken one.
 */
export const getCoverage = createServerFn({ method: "GET" })
  .inputValidator(z.object({}))
  .handler(async (): Promise<{ coverage: MarketCoverage[]; totalGrants: number }> => {
    const env = serverEnv();
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const [{ data: freshness }, { data: counts }] = await Promise.all([
      supabase.from("source_freshness").select("source_key, last_ok_at"),
      supabase.from("grants").select("source_key"),
    ]);

    const lastOk = new Map<string, string | null>(
      ((freshness ?? []) as Array<{ source_key: string; last_ok_at: string | null }>).map((row) => [
        row.source_key,
        row.last_ok_at,
      ]),
    );

    const grantsPerSource = new Map<string, number>();
    for (const row of (counts ?? []) as Array<{ source_key: string }>) {
      grantsPerSource.set(row.source_key, (grantsPerSource.get(row.source_key) ?? 0) + 1);
    }

    const health: SourceHealth[] = SOURCES.map((source) => {
      const last = lastOk.get(source.key) ?? null;
      return {
        key: source.key,
        label: source.label,
        market: source.market,
        cadenceHours: source.cadenceHours,
        lastRunAt: last ? new Date(last) : null,
        grantCount: grantsPerSource.get(source.key) ?? 0,
      };
    });

    return {
      coverage: coverageByMarket(health),
      totalGrants: [...grantsPerSource.values()].reduce((a, b) => a + b, 0),
    };
  });
