import { expect, test } from "@playwright/test";

/**
 * Two consultants at the same firm, sharing one client.
 *
 * Every product researched to build this (Instrumentl's Collaborator seats,
 * Submittable's submission collaboration, Foundant's multi-user accounts)
 * has some form of this, and GrantDesk had none — a client's own consultant
 * was the only person who could ever see its matches or drafts. This is the
 * path that closes that gap: add a colleague by email, they see the shared
 * desk from their own account, and either side can end the sharing.
 */

const stamp = Date.now();
const OWNER = { email: `team-owner-${stamp}@grantdesk.test`, password: "GrantDesk-E2E-2026!" };
const COLLEAGUE = {
  email: `team-colleague-${stamp}@grantdesk.test`,
  password: "GrantDesk-E2E-2026!",
};
const CLIENT_NAME = `Shared Client ${stamp}`;

async function signUp(page: import("@playwright/test").Page, creds: typeof OWNER) {
  await page.goto("/auth");
  await expect(page.locator("html[data-hydrated='true']")).toBeAttached({ timeout: 30_000 });
  await page.locator('input[name="email"]').fill(creds.email);
  await page.locator('input[name="password"]').fill(creds.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/clients$/, { timeout: 30_000 });
}

async function signIn(page: import("@playwright/test").Page, creds: typeof OWNER) {
  await page.goto("/auth");
  await expect(page.locator("html[data-hydrated='true']")).toBeAttached({ timeout: 30_000 });
  await page.locator('input[name="email"]').fill(creds.email);
  await page.locator('input[name="password"]').fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/clients$/, { timeout: 30_000 });
}

test("a colleague added to a client sees the same desk, and either side can end it", async ({
  page,
  browser,
}) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  // ── The colleague needs an account before they can be found by email ──────
  const second = await browser.newContext();
  const colleaguePage = await second.newPage();
  await signUp(colleaguePage, COLLEAGUE);
  await colleaguePage.close();

  // ── Owner creates the client ───────────────────────────────────────────────
  await signUp(page, OWNER);
  await page.locator('input[name="clientName"]').fill(CLIENT_NAME);
  await page.locator('input[name="clientWebsite"]').fill("https://example.org");
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page).toHaveURL(/\/clients\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  const team = page.getByTestId("team");
  await expect(team).toBeVisible();
  await expect(team).toContainText("You");
  await expect(team).toContainText("Owner");

  // ── Owner adds the colleague ───────────────────────────────────────────────
  await page.getByPlaceholder("colleague@yourfirm.com").fill(COLLEAGUE.email);
  await page.getByTestId("add-teammate").click();
  await expect(page.getByText(new RegExp(`Added ${COLLEAGUE.email}`))).toBeVisible({
    timeout: 15_000,
  });
  await expect(team.getByTestId("team-member")).toHaveCount(1);

  const clientUrl = page.url();

  // ── The colleague, from their own session, sees the shared client ─────────
  const colleagueContext = await browser.newContext();
  const asColleague = await colleagueContext.newPage();
  await signIn(asColleague, COLLEAGUE);

  // The client list is plain RLS-filtered SELECT — this is the assertion that
  // sharing actually reaches every table, not just the one row directly
  // clicked into.
  await expect(asColleague.getByText(CLIENT_NAME)).toBeVisible({ timeout: 15_000 });

  await asColleague.goto(clientUrl);
  await expect(asColleague.getByTestId("team")).toContainText("You");
  // Not the owner: no way to add a third person.
  await expect(asColleague.getByPlaceholder("colleague@yourfirm.com")).toBeHidden();
  await expect(asColleague.getByRole("button", { name: "Leave" })).toBeVisible();

  // ── The colleague leaves ───────────────────────────────────────────────────
  await asColleague.getByRole("button", { name: "Leave" }).click();
  await expect(asColleague.getByText(/left this client/i)).toBeVisible({ timeout: 15_000 });
  await colleagueContext.close();

  // ── The owner sees the departure without doing anything ────────────────────
  await page.reload();
  await expect(page.getByTestId("team").getByTestId("team-member")).toHaveCount(0);

  expect(consoleErrors, `page errors: ${consoleErrors.join("; ")}`).toEqual([]);
});
