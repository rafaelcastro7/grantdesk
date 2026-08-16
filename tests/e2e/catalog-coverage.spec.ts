import { expect, test } from "@playwright/test";

/**
 * Phase 2's gate: the catalog page states, per market, what is genuinely
 * refreshed and what is only a directory.
 *
 * Asserting the honesty rather than a number — the counts move with every
 * ingestion run, but "a market with no ingested calls must not be presented
 * like one that has them" is the invariant worth defending.
 */
test("the catalog states its coverage per market", async ({ page }) => {
  await page.goto("/catalog");
  await expect(page.locator("html[data-hydrated='true']")).toBeAttached({ timeout: 30_000 });

  await expect(page.getByRole("heading", { name: "Where our results come from" })).toBeVisible();

  const list = page.getByTestId("coverage-list");
  await expect(list).toBeVisible({ timeout: 30_000 });

  // Both ingesting markets are present and described.
  await expect(list.getByText("Canada")).toBeVisible();
  await expect(list.getByText("United States")).toBeVisible();

  const total = await page.getByTestId("total-grants").textContent();
  expect(Number((total ?? "0").replace(/,/g, ""))).toBeGreaterThan(0);

  // Every market carries a verdict, not just a count: this is the line the
  // predecessor crossed when it listed funders search could never reach.
  const verdicts = await list.locator("li").allTextContents();
  expect(verdicts.length).toBeGreaterThan(0);
  for (const row of verdicts) {
    expect(row).toMatch(/Automatic|Out of date|Directory only/);
  }
});
