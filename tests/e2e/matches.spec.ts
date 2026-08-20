import { expect, test } from "@playwright/test";

/**
 * Phase 3's gate, driven the way a consultant would: fill a profile by hand,
 * run matching, and read verdicts with their reasons.
 *
 * The profile is typed rather than extracted here. Phase 1's e2e already
 * covers extraction, and depending on a third-party page plus a model to reach
 * the screen under test would mean a matching regression and a website outage
 * produce the same red — the test would stop telling us which.
 */

const stamp = Date.now();
const EMAIL = `matches-${stamp}@grantdesk.test`;
const PASSWORD = "GrantDesk-E2E-2026!";

test("a consultant matches a client and sees why each result was ruled in or out", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/auth");
  await expect(page.locator("html[data-hydrated='true']")).toBeAttached({ timeout: 30_000 });
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/clients$/, { timeout: 30_000 });

  await page.locator('input[name="clientName"]').fill(`Ravine Keepers ${stamp}`);
  await page.locator('input[name="clientWebsite"]').fill("https://example.org");
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page).toHaveURL(/\/clients\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  // Matching must be refused until the profile can support it — an empty
  // profile would produce a page of guesses no rule could stand behind.
  await expect(page.getByTestId("can-match")).toContainText("Matching is off");
  await expect(page.getByTestId("to-matches")).toBeHidden();

  await page.locator('input[name="jurisdictions"]').fill("CA-ON");
  await page.locator('input[name="sectors"]').fill("environment, community");
  await page.locator('input[name="stage"]').fill("nonprofit");
  await page.locator('input[name="annualBudget"]').fill("450000");
  await page.getByRole("button", { name: "Save profile" }).click();

  await expect(page.getByTestId("can-match")).toContainText("Ready to match.", { timeout: 30_000 });
  await expect(page.getByTestId("completeness")).not.toHaveText("0/100");

  await page.getByTestId("to-matches").click();
  await expect(page).toHaveURL(/\/matches$/, { timeout: 30_000 });

  // Matching starts by itself on arrival — the click carried no decision, only
  // a delay. What the test asserts is therefore the outcome, not the click.
  const run = page.getByTestId("run-matching");
  await expect(run).toBeVisible();

  // Retrieval plus an embedding call against the live catalog; wait on the
  // outcome, and accept a stated failure over a silent one.
  const summary = page.getByTestId("match-summary");
  const failure = page.getByRole("alert");
  await expect(summary.or(failure)).toBeVisible({ timeout: 120_000 });

  if (await failure.isVisible()) {
    const message = (await failure.textContent()) ?? "";
    expect(message).not.toContain("[object Object]");
    throw new Error(`matching failed rather than returning results: ${message}`);
  }

  await expect(summary).toContainText(/Checked \d+ calls/);

  // The product's actual claim: results are grouped by verdict, and the ones
  // ruled out are collapsed rather than dropped.
  // Every result says why it is relevant, separately from whether it is
  // allowed. The incumbent gives a match score with nothing behind it and its
  // own users describe re-checking each result by hand; a claim you have to
  // verify is worth less than no claim, so this one is checkable at a glance.
  const why = page.getByTestId("why-relevant").first();
  await expect(why).toBeVisible();
  await expect(why).toContainText(/mentions "|No shared wording/);

  const ruledOut = page.getByTestId("group-ineligible");
  await expect(ruledOut).toBeVisible();
  await expect(ruledOut).toContainText("Ruled out");

  await ruledOut.getByRole("button", { name: "Show why" }).click();
  const firstRuledOut = ruledOut.getByTestId("match-card").first();
  await expect(firstRuledOut).toBeVisible();

  // A verdict with no stated reason is the failure this phase exists to
  // prevent — it is indistinguishable from an opinion.
  await firstRuledOut.getByText("Every rule, and how this was found").click();
  await expect(firstRuledOut).toContainText(/Restricted to|Closed on|Open to/);

  // Two halves of one promise, and getting them backwards is how this was
  // first built: the record keeps every rejection, the screen shows a bounded
  // sample of them. The heading counts the record, so it must agree with the
  // run summary — if a rejection were dropped on the way to the database, the
  // two numbers would drift apart and no other test would notice.
  const stated = /(\d+) ruled out/.exec((await summary.textContent()) ?? "")?.[1];
  expect(stated, "the run summary did not state a ruled-out count").toBeTruthy();
  await expect(ruledOut.getByRole("heading")).toContainText(String(stated));

  // At most a page of rejections, plus the line that says so.
  const shown = await ruledOut.getByTestId("match-card").count();
  expect(shown).toBeLessThanOrEqual(12);
  if (Number(stated) > 12) {
    await expect(ruledOut.getByTestId("ruled-out-truncated")).toContainText(
      `Showing 12 of ${stated}`,
    );
  }

  expect(consoleErrors, `page errors: ${consoleErrors.join("; ")}`).toEqual([]);
});
