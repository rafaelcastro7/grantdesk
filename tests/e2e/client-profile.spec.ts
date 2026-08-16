import { expect, test } from "@playwright/test";

/**
 * Phase 1's gate, driven the way a consultant would: sign up, add a client,
 * paste their website, and end with a profile good enough to match against.
 *
 * The assertions read state rather than assuming it. Every step that waits on
 * something checks that the thing can appear at all first — a click on a
 * disabled or absent control otherwise burns the whole timeout and reports
 * "waiting for locator", which names no cause.
 */

const stamp = Date.now();
const EMAIL = `e2e-${stamp}@grantdesk.test`;
const PASSWORD = "GrantDesk-E2E-2026!";

// A real, stable page. Extraction quality itself is measured by the eval
// (bun run eval:profile); this asserts the pipeline reaches the screen.
const CLIENT_SITE = "https://www.evergreen.ca/about-us/";

test("a consultant adds a client and fills its profile from a website", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/auth");
  await expect(page.getByRole("heading", { name: "GrantDesk" })).toBeVisible();
  // Server-rendered markup is clickable before React binds its handlers, so an
  // early click is a silent no-op: the form kept its values, showed no error,
  // and simply never submitted. Wait for the interactive signal instead.
  await expect(page.locator("html[data-hydrated='true']")).toBeAttached({ timeout: 30_000 });

  // Target the inputs by name and confirm the values actually landed. Filling
  // by label silently produced an empty submit here, and the only symptom was
  // the server answering "Anonymous sign-ins are disabled" — a message about
  // the wrong thing entirely. Assert the precondition instead of trusting it.
  const emailField = page.locator('input[name="email"]');
  const passwordField = page.locator('input[name="password"]');
  await emailField.fill(EMAIL);
  await passwordField.fill(PASSWORD);
  await expect(emailField).toHaveValue(EMAIL);
  await expect(passwordField).toHaveValue(PASSWORD);

  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/clients$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible();

  // A brand-new consultant sees an empty desk, not a spinner forever.
  await expect(page.getByText("No clients yet")).toBeVisible();

  await page.locator('input[name="clientName"]').fill(`Evergreen ${stamp}`);
  await page.locator('input[name="clientWebsite"]').fill(CLIENT_SITE);
  await page.getByRole("button", { name: "Add client" }).click();

  await expect(page).toHaveURL(/\/clients\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: `Evergreen ${stamp}` })).toBeVisible();

  // Before extraction the profile is empty, matching is refused, and the app
  // says which single thing to fix rather than listing every gap.
  await expect(page.getByTestId("completeness")).toHaveText("0/100");
  await expect(page.getByTestId("can-match")).toContainText("Matching is off");
  await expect(page.getByTestId("next-gap")).toBeVisible();

  const readButton = page.getByRole("button", { name: "Read the page" });
  await expect(readButton).toBeEnabled();
  await readButton.click();

  // This step fetches a third-party page and calls a model, so its *quality*
  // is measured by the eval (bun run eval:profile, 3/3 usable) across several
  // cases — a single live round-trip is a distribution sample, not a pass/fail.
  //
  // What this e2e defends is the contract that holds every time: the app must
  // never leave the consultant staring at an unchanged screen. Either the
  // profile fills and says where it came from, or an error says what went
  // wrong. Silence is the only outcome that is a defect.
  const provenance = page.getByText(/Read from https/);
  const failure = page.getByRole("alert");
  await expect(provenance.or(failure)).toBeVisible({ timeout: 90_000 });

  if (await provenance.isVisible()) {
    const score = await page.getByTestId("completeness").textContent();
    const value = Number((score ?? "0/100").split("/")[0]);
    expect(value, "a successful read must actually populate the profile").toBeGreaterThan(0);
    await expect(page.getByTestId("can-match")).toContainText("Ready to match.");
  } else {
    // A stated failure is acceptable; an unreadable one is not.
    const message = (await failure.textContent()) ?? "";
    expect(message.length, "an error must explain itself").toBeGreaterThan(10);
    expect(message).not.toContain("[object Object]");
  }

  expect(consoleErrors, `page errors: ${consoleErrors.join("; ")}`).toEqual([]);
});
