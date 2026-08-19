import { expect, test } from "@playwright/test";

/**
 * Every screen is reachable, and a returning user can get back in.
 *
 * Both of these were genuinely broken and neither was caught by the other
 * specs, because each of those starts by creating a fresh account and then
 * walks a single path forward. `/catalog` had no link pointing at it anywhere
 * in the codebase — a screen whose whole purpose is to state coverage honestly,
 * findable only by typing the URL — and the sign-in button, which a real user
 * presses far more often than "Create account", had never once been exercised.
 */

const stamp = Date.now();
const EMAIL = `nav-${stamp}@grantdesk.test`;
const PASSWORD = "GrantDesk-E2E-2026!";

test("a returning consultant signs back in and can reach every screen", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  // ── Create an account, then leave ─────────────────────────────────────────
  await page.goto("/auth");
  await expect(page.locator("html[data-hydrated='true']")).toBeAttached({ timeout: 30_000 });
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/clients$/, { timeout: 30_000 });

  await page.context().clearCookies();
  await page.evaluate(() => window.localStorage.clear());

  // ── Come back and sign in ─────────────────────────────────────────────────
  // The path a real consultant takes every morning, and the one no other spec
  // had ever run.
  await page.goto("/auth");
  await expect(page.locator("html[data-hydrated='true']")).toBeAttached({ timeout: 30_000 });
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/clients$/, { timeout: 30_000 });

  // ── Every screen, from the bar ────────────────────────────────────────────
  const nav = page.getByTestId("nav");
  await expect(nav).toBeVisible();

  await nav.getByRole("link", { name: "Coverage" }).click();
  await expect(page).toHaveURL(/\/catalog$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Where our results come from" })).toBeVisible();
  // The current page is marked, or the bar tells the user nothing about where
  // they are.
  await expect(nav.getByRole("link", { name: "Coverage" })).toHaveAttribute("aria-current", "page");

  await nav.getByRole("link", { name: "Due" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "What is due" })).toBeVisible();

  await nav.getByRole("link", { name: "Clients" }).click();
  await expect(page).toHaveURL(/\/clients$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible();

  // ── But not on the sign-in screen ─────────────────────────────────────────
  // There is nowhere to go from there, and a bar full of dead ends is worse
  // than no bar.
  await page.goto("/auth");
  await expect(page.getByTestId("nav")).toBeHidden();

  expect(consoleErrors, `page errors: ${consoleErrors.join("; ")}`).toEqual([]);
});
