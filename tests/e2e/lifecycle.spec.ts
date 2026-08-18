import { expect, test } from "@playwright/test";

/**
 * The whole product, in one run: sign up, add a client, fill their profile,
 * match, read what a call requires, draft against it, keep the answer, and
 * record the submission.
 *
 * This is Phase 5's gate and it deliberately runs end to end rather than as
 * five separate specs. Each step here works in isolation — that is what the
 * other specs prove — and the thing this one is for is that they still work in
 * sequence, with real data flowing between them.
 *
 * The section is added from the funder's form rather than waiting for
 * extraction to produce a writable one. That is not a shortcut around the
 * feature: most funders publish their conditions on the web and keep the
 * section list in the application form itself, so a product that only works
 * when the sections are machine-readable does not work.
 */

const stamp = Date.now();
const EMAIL = `lifecycle-${stamp}@grantdesk.test`;
const PASSWORD = "GrantDesk-E2E-2026!";

test("a consultant goes from a new client to a recorded submission", async ({ page }) => {
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

  // ── Who has won this before ───────────────────────────────────────────────
  // Either real recipients, or a statement of why we cannot see them. An empty
  // list would read as "nobody has ever won this", which is a far stronger
  // claim than the data supports.
  await page.getByTestId("past-awards").click();
  await expect(page.getByTestId("awards-panel")).toBeVisible({ timeout: 60_000 });

  // ── The submit gate ───────────────────────────────────────────────────────
  const send = page.getByTestId("send");
  await expect(send).toBeVisible();
  await send.getByTestId("check-readiness").click();

  const blockers = page.getByTestId("blockers");
  await expect(blockers).toBeVisible({ timeout: 60_000 });
  // The confirmation is always outstanding until a person gives it — the gate
  // must never mark an application reviewed on its own.
  await expect(blockers).toContainText("Nobody has confirmed they read this");

  // Any condition the call rejects applications without has to be confirmed
  // before the gate will pass, because software cannot verify it.
  const conditionBoxes = page.getByTestId("conditions").getByRole("checkbox");
  for (let i = 0; i < (await conditionBoxes.count()); i++) {
    await conditionBoxes.nth(i).check();
  }

  await send.getByTestId("check-readiness").click();
  await expect(blockers).not.toContainText("Confirm you have it", { timeout: 60_000 });

  await send.getByTestId("submit-proposal").click();

  const submitted = page.getByTestId("submitted");
  const submitFailure = page.getByRole("alert");
  await expect(submitted.or(submitFailure)).toBeVisible({ timeout: 60_000 });

  if (await submitFailure.isVisible()) {
    const message = (await submitFailure.textContent()) ?? "";
    expect(message).not.toContain("[object Object]");
    throw new Error(`submission was refused rather than recorded: ${message}`);
  }
  await expect(submitted).toContainText("Submitted");

  // ── And it shows up on the desk ───────────────────────────────────────────
  // The first question in the spec: what is due across all my clients. A
  // submission that does not appear here is one the consultant will re-do.
  await page.goto("/");
  await expect(page.getByTestId("sent-list")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("sent-list")).toContainText("awaiting");

  expect(consoleErrors, `page errors: ${consoleErrors.join("; ")}`).toEqual([]);
});
