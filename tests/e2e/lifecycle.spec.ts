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
  // Matching runs on arrival; no click needed.
  await expect(page.getByTestId("match-summary")).toBeVisible({ timeout: 120_000 });

  // Drafting is only offered where the rules said applying is possible.
  const eligible = page.getByTestId("group-eligible");
  await expect(eligible).toBeVisible({ timeout: 30_000 });
  await eligible.getByTestId("to-proposal").first().click();
  await expect(page).toHaveURL(/\/proposals\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  // The call reads itself on arrival too. Either it yields requirements, or it
  // says why not — a silent no-op is the only unacceptable outcome.
  await expect(page.getByTestId("read-call")).toBeVisible();

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

  // Draft every section the funder asked for, not just the one we added. The
  // gate refuses to submit with an unwritten section — correctly — so a run
  // that drafts only one is not the lifecycle, it is a fragment of it.
  const cards = page.getByTestId("section-card");
  for (let i = 0; i < (await cards.count()); i++) {
    const section = cards.nth(i);
    const draft = section.getByRole("button", { name: "Draft this" });
    if (await draft.isVisible()) {
      await draft.click();
      await expect(section.getByRole("button", { name: "Draft again" })).toBeVisible({
        timeout: 180_000,
      });
    }
  }

  const body = card.getByRole("textbox", { name: "Organizational Capacity" });
  await expect(body).not.toHaveValue("");

  // The draft has to be attributable and countable against the funder's limit.
  await expect(card).toContainText(/Drafted by \S+\/\S+/);
  await expect(card).toContainText(/\d+\/250 words/);
  await expect(page.getByTestId("draft-progress")).toContainText(/of \d+ sections drafted/);

  // ── Filling what the draft admitted it did not know ───────────────────────
  // The model marks a missing fact as [NEED: ...] rather than inventing one,
  // and the submit gate refuses to send while any remain — a literal
  // "[NEED: how many]" reaching a funder is the most visible way to look
  // careless. So the consultant fills them in, which is also the only path
  // that exercises editing and saving a section by hand.
  for (let i = 0; i < (await cards.count()); i++) {
    const section = cards.nth(i);
    const box = section.getByRole("textbox");
    const text = await box.inputValue();
    if (!text.includes("[NEED:")) continue;

    await box.fill(text.replace(/\[NEED:[^\]]*\]/g, "400"));
    await section.getByRole("button", { name: "Save" }).click();
    await expect(section.getByRole("button", { name: "Save" })).toBeHidden({ timeout: 30_000 });
  }

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

  // Nothing hard may remain: the button enables itself only when every
  // non-overridable check has passed. Waiting on that is the assertion.
  const submit = send.getByTestId("submit-proposal");
  await expect(submit, `blockers still standing: ${await blockers.innerText()}`).toBeEnabled({
    timeout: 60_000,
  });
  await submit.click();

  const submitted = page.getByTestId("submitted");
  const submitFailure = page.getByRole("alert");
  await expect(submitted.or(submitFailure)).toBeVisible({ timeout: 60_000 });

  if (await submitFailure.isVisible()) {
    const message = (await submitFailure.textContent()) ?? "";
    expect(message).not.toContain("[object Object]");
    throw new Error(`submission was refused rather than recorded: ${message}`);
  }
  await expect(submitted).toContainText("Submitted");

  // ── Tracking what came back ───────────────────────────────────────────────
  // The other half of "submit and track". Without this the outcome column had
  // four states and exactly one reachable.
  const outcome = page.getByTestId("outcome-form");
  await expect(outcome).toBeVisible();
  await outcome.getByLabel("What happened").selectOption("awarded");
  await outcome.getByLabel("Their reference number").fill(`REF-${stamp}`);
  await outcome.getByTestId("save-outcome").click();
  await expect(submitted).toContainText("awarded", { timeout: 30_000 });
  await expect(submitted).toContainText(`REF-${stamp}`);

  // ── And it shows up on the desk ───────────────────────────────────────────
  // The first question in the spec: what is due across all my clients. A
  // submission that does not appear here is one the consultant will re-do.
  await page.goto("/");
  const sent = page.getByTestId("sent-list");
  await expect(sent).toBeVisible({ timeout: 30_000 });
  // The desk shows what actually happened, not a frozen "awaiting".
  await expect(sent).toContainText("awarded");

  expect(consoleErrors, `page errors: ${consoleErrors.join("; ")}`).toEqual([]);
});
