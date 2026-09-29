import { expect, test } from "@playwright/test";

/**
 * The controls the happy path never touches.
 *
 * The other specs each walk one route forward, which leaves a specific class of
 * control untested: the ones that only appear *after* something has already
 * happened. Re-running matching, re-reading a call, collapsing the ruled-out
 * list again — every one of these is a second click on a screen the forward
 * path has already left behind, and every one is a control a real consultant
 * uses constantly.
 *
 * Two testids were also being carried in the markup with nothing asserting
 * them, which is worse than no testid: it reads like coverage that does not
 * exist.
 */

const stamp = Date.now();
const EMAIL = `controls-${stamp}@grantdesk.test`;
const PASSWORD = "GrantDesk-E2E-2026!";

test("the second-click controls work: re-run, re-read, collapse", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/auth");
  await expect(page.locator("html[data-hydrated='true']")).toBeAttached({ timeout: 30_000 });
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/clients$/, { timeout: 30_000 });

  await page.locator('input[name="clientName"]').fill(`Controls ${stamp}`);
  await page.locator('input[name="clientWebsite"]').fill("https://example.org");
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page).toHaveURL(/\/clients\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  // The profile form itself, which had a testid and no assertion.
  const profileForm = page.getByTestId("profile-form");
  await expect(profileForm).toBeVisible();
  await profileForm.locator('input[name="jurisdictions"]').fill("US");
  await profileForm.locator('input[name="sectors"]').fill("health-wellbeing");
  await profileForm.locator('input[name="stage"]').fill("nonprofit");
  await profileForm.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByTestId("can-match")).toContainText("Ready to match.", { timeout: 30_000 });

  // An edit must actually replace what is stored, not append to it. The field
  // is uncontrolled, so a stale key would quietly save the old value back.
  await profileForm.locator('input[name="sectors"]').fill("health-wellbeing, community");
  await profileForm.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved.")).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(profileForm.locator('input[name="sectors"]')).toHaveValue(
    /health-wellbeing.*community/,
    { timeout: 30_000 },
  );

  await page.getByTestId("to-matches").click();
  await expect(page.getByTestId("match-summary")).toBeVisible({ timeout: 120_000 });

  // ── Re-running matching ───────────────────────────────────────────────────
  // The button relabels itself once there are results, because by then it is a
  // real decision rather than the first step.
  const rerun = page.getByTestId("run-matching");
  await expect(rerun).toHaveText("Check again");
  await rerun.click();
  await expect(rerun).toHaveText("Checking the catalog…");
  await expect(rerun).toHaveText("Check again", { timeout: 120_000 });

  // ── Collapsing the ruled-out list, both ways ──────────────────────────────
  const ruledOut = page.getByTestId("group-ineligible");
  await expect(ruledOut).toBeVisible({ timeout: 30_000 });
  // Collapsed by default: it is evidence, not the answer.
  await expect(ruledOut.locator("li")).toHaveCount(0);

  await ruledOut.getByRole("button", { name: "Show why" }).click();
  expect(await ruledOut.locator("li").count()).toBeGreaterThan(0);

  await ruledOut.getByRole("button", { name: "Hide" }).click();
  await expect(ruledOut.locator("li")).toHaveCount(0);

  // ── Re-reading a call ─────────────────────────────────────────────────────
  // Verified or not, an eligible call opens the same way.
  await page
    .getByTestId("group-eligible")
    .or(page.getByTestId("group-unverified"))
    .first()
    .getByTestId("to-proposal")
    .first()
    .click();
  await expect(page).toHaveURL(/\/proposals\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  const read = page.getByTestId("read-call");
  // Reading happens on arrival. It settles either on requirements (the label
  // becomes the re-read one) or on the text it read with no requirements in
  // it — both are answers; a button stuck on "Reading" is not.
  await expect(read).not.toHaveText("Reading the call…", { timeout: 120_000 });
  if ((await read.textContent())?.trim() !== "Re-read the call") {
    await expect(page.getByTestId("read-text")).toBeVisible();
    expect(consoleErrors, `page errors: ${consoleErrors.join("; ")}`).toEqual([]);
    return;
  }

  const countRequirements = async () =>
    (await page.getByTestId("section-card").count()) +
    (await page.getByTestId("conditions").locator("li").count());
  const beforeReread = await countRequirements();

  await read.click();
  await expect(read).toHaveText("Reading the call…");
  await expect(read).toHaveText("Re-read the call", { timeout: 120_000 });

  // Re-reading revises rather than duplicates: the same call must not end up
  // asking for the same section twice.
  const headings = await page.getByTestId("section-card").locator("h3").allTextContents();
  const conditionLabels = await page
    .getByTestId("conditions")
    .locator("li > div > span:first-child")
    .allTextContents();
  const all = [...headings, ...conditionLabels].map((t) => t.trim());
  expect(new Set(all).size, `duplicated requirements: ${all.join(" | ")}`).toBe(all.length);

  // The list must be *replaced* by a re-read, not accumulated onto. A model
  // does not word a heading the same way twice, so the label-keyed upsert used
  // to turn one pass's six conditions into nineteen near-synonyms across two.
  //
  // Not asserted as "no larger than before": two readings of the same call
  // legitimately differ by a requirement or two, and pinning that treats model
  // variance as a regression — the mistake Phase 1 already paid for, and this
  // assertion did fail that way once. What accumulation actually looks like is
  // roughly doubling, and that is what this rules out.
  const afterReread = await countRequirements();
  expect(
    afterReread,
    `requirements went from ${beforeReread} to ${afterReread} on a re-read, which looks like accumulation rather than replacement`,
  ).toBeLessThan(beforeReread * 2);

  expect(consoleErrors, `page errors: ${consoleErrors.join("; ")}`).toEqual([]);
});
