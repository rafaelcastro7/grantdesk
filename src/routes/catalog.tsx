import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { getCoverage } from "@/server/catalog.functions";
import { errorMessage } from "@/lib/error-message";
import type { MarketCoverage } from "@/lib/coverage";

export const Route = createFileRoute("/catalog")({ component: CatalogPage });

const LEVEL_STYLE: Record<MarketCoverage["level"], { label: string; className: string }> = {
  automatic: { label: "Automatic", className: "text-[var(--color-eligible)]" },
  partial: { label: "Out of date", className: "text-[var(--color-needs-input)]" },
  "directory-only": { label: "Directory only", className: "text-[var(--color-ink-soft)]" },
};

const MARKET_NAMES: Record<string, string> = {
  CA: "Canada",
  US: "United States",
  INTL: "Multilateral",
  MX: "Mexico",
  BR: "Brazil",
};

/**
 * Coverage, stated plainly.
 *
 * This page exists because the predecessor advertised a catalog it did not
 * have — 699 funders of which search could reach five. A consultant deciding
 * where to spend an hour is entitled to know which markets we actually refresh
 * and which are a directory with a link.
 */
function CatalogPage() {
  const fetchCoverage = useServerFn(getCoverage);
  const [data, setData] = useState<{ coverage: MarketCoverage[]; totalGrants: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setData(await fetchCoverage({ data: {} }));
      } catch (caught) {
        setError(errorMessage(caught));
      }
    })();
  }, [fetchCoverage]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Where our results come from</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-ink-soft)]">
        Each market says what it really is. A market we do not refresh automatically is listed as a
        directory, not padded out to look like the rest.
      </p>

      {error && (
        <p role="alert" className="mt-6 text-sm text-[var(--color-ineligible)]">
          {error}
        </p>
      )}

      {data && (
        <>
          <p className="mt-6 text-sm">
            <span data-testid="total-grants" className="font-mono tabular-nums">
              {data.totalGrants.toLocaleString()}
            </span>{" "}
            open calls in the catalog.
          </p>

          <ul
            data-testid="coverage-list"
            className="mt-4 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]"
          >
            {data.coverage.map((market) => {
              const style = LEVEL_STYLE[market.level];
              return (
                <li key={market.market} className="bg-[var(--color-surface)] px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">
                      {MARKET_NAMES[market.market] ?? market.market}
                    </span>
                    <span className={`text-xs font-medium ${style.className}`}>{style.label}</span>
                  </div>
                  <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{market.statement}</p>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {data === null && !error && (
        <p className="mt-6 text-sm text-[var(--color-ink-soft)]">Loading…</p>
      )}
    </main>
  );
}
