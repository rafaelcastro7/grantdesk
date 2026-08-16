import { expect, test } from "@playwright/test";

/**
 * Phase 4's gate: a consultant reads what a call requires, drafts against those
 * requirements, and keeps an answer for next time.
 *
 * The section is added from the funder's form rather than relying on extraction
 * to produce a writable one. That is not a shortcut around the feature — it is
 * the common real case: most funders publish their conditions on the web and
 * keep the section list in the application form itself, so a product that only
 * works when the sections are machine-readable does not work.
 */

const stamp = Date.now();
const EMAIL = `proposal-${stamp}@grantdesk.test`;
const PASSWORD = "GrantDesk-E2E-2026!";

test("a consultant drafts a section against a call and keeps it for reuse", async ({ page }) => {
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

  await page.locator('input[name="jurisdictions"]').fill("US");
  await page.locator('input[name="sectors"]').fill("health-wellbeing, community");
  await page.locator('input[name="stage"]').fill("nonprofit");
  await page.locator('input[name="annualBudget"]').fill("450000");
  await page
    .locator('input[name="capabilities"]')
    .fill("We have run a community clinic since 2011 across 6 sites.");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByTestId("can-match")).toContainText("Ready to match.", { timeout: 30_000 });

  await page.getByTestId("to-matches").click();
  await page.getByTestId("run-matching").click();
  await expect(page.getByTestId("match-summary")).toBeVisible({ timeout: 120_000 });

  // Drafting is only offered where the rules said applying is possible.
  const eligible = page.getByTestId("group-eligible");
  await expect(eligible).toBeVisible({ timeout: 30_000 });
  await eligible.getByTestId("to-proposal").first().click();
  await expect(page).toHaveURL(/\/proposals\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  // Reading the call: either it yields requirements, or it says why not. A
  // silent no-op is the only unacceptable outcome.
  const read = page.getByTestId("read-call");
  await expect(read).toBeEnabled();
  await read.click();

  const conditions = page.getByTestId("conditions");
  const failure = page.getByRole("alert");
  await expect(conditions.or(failure)).toBeVisible({ timeout: 120_000 });

  if (await failure.isVisible()) {
    const message = (await failure.textContent()) ?? "";
    expect(message).not.toContain("[object Object]");
    // A call published only as a PDF is a real outcome, and the message must
    // point at the manual path rather than leaving the consultant stuck.
    expect(message).toMatch(/PDF|add the sections/i);
  }

  // The section list usually lives in the funder's form, so the consultant
  // types the heading and drafting proceeds from there.
  await page.locator('input[name="label"]').fill("Organizational Capacity");
  await page.locator('input[name="wordLimit"]').fill("250");
  await page.getByTestId("add-section").click();

  const card = page.getByTestId("section-card").filter({ hasText: "Organizational Capacity" });
  await expect(card).toBeVisible({ timeout: 30_000 });

  await card.getByRole("button", { name: "Draft this" }).click();

  const body = card.getByRole("textbox", { name: "Organizational Capacity" });
  await expect(body).not.toHaveValue("", { timeout: 180_000 });

  // The draft has to be attributable and countable against the funder's limit.
  await expect(card).toContainText(/Drafted by \S+\/\S+/);
  await expect(card).toContainText(/\d+\/250 words/);
  await expect(page.getByTestId("draft-progress")).toContainText(/of \d+ sections drafted/);

  // Kept for reuse — the whole promised time saving on the next call.
  await card.getByRole("button", { name: "Keep for next time" }).click();
  await expect(page.getByText(/the next call that asks this will reuse it/)).toBeVisible({
    timeout: 60_000,
  });

  expect(consoleErrors, `page errors: ${consoleErrors.join("; ")}`).toEqual([]);
});
