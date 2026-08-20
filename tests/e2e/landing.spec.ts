import { expect, test } from "@playwright/test";

/**
 * One address, two audiences.
 *
 * `/` is the landing for a visitor and the desk for a signed-in consultant.
 * Both are asserted here, because the failure this guards against is the
 * useful half disappearing: a landing that keeps showing after sign-in, or a
 * desk that greets a stranger with an empty list and no explanation.
 */

const stamp = Date.now();
const EMAIL = `landing-${stamp}@grantdesk.test`;
const PASSWORD = "GrantDesk-E2E-2026!";

test("a visitor gets the case for the product, a consultant gets their desk", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  // ── Signed out ────────────────────────────────────────────────────────────
  await page.goto("/");
  await expect(page.locator("html[data-hydrated='true']")).toBeAttached({ timeout: 30_000 });

  await expect(page.getByRole("heading", { name: /Fewer results, verified/ })).toBeVisible();
  await expect(page.getByText("What it will not do")).toBeVisible();

  // The coverage figures are read from the catalog as the page loads rather
  // than written into the copy — a number typed into marketing is a number
  // nobody updates, and this product's whole argument is about not overstating.
  const coverage = page.getByTestId("landing-coverage");
  await expect(coverage).toBeVisible({ timeout: 30_000 });
  const shown = (await coverage.textContent()) ?? "";
  const total = Number((shown.match(/([\d,]+)\s*open calls/)?.[1] ?? "0").replace(/,/g, ""));
  expect(total, "the landing should state a real catalog size").toBeGreaterThan(0);

  // Both routes it offers actually go somewhere.
  await page.getByRole("link", { name: /See exactly what we cover/ }).click();
  await expect(page).toHaveURL(/\/catalog$/, { timeout: 30_000 });

  await page.goto("/");
  await page.getByTestId("landing-cta").click();
  await expect(page).toHaveURL(/\/auth$/, { timeout: 30_000 });

  // ── Signed in ─────────────────────────────────────────────────────────────
  await expect(page.locator("html[data-hydrated='true']")).toBeAttached({ timeout: 30_000 });
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/clients$/, { timeout: 30_000 });

  await page.goto("/");
  // The desk, not the pitch. A landing that keeps showing after sign-in is the
  // failure this half exists to catch.
  await expect(page.getByRole("heading", { name: "What is due" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /Fewer results, verified/ })).toBeHidden();

  expect(consoleErrors, `page errors: ${consoleErrors.join("; ")}`).toEqual([]);
});
