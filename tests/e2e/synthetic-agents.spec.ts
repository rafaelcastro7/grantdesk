import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { DumbAgent } from "./synthetic/dumb-agent";

/**
 * Synthetic grant managers.
 *
 * Three scripted personas walk the product using only what is on screen and
 * check that every fact a grant manager needs to do the job can be found. They
 * are dumb on purpose — see DumbAgent. A need that goes unmet fails the run and
 * lands in test-results/synthetic-agents/<persona>.md with what the screen
 * showed instead.
 *
 * No model drafting is triggered (the shared token budget belongs to the
 * lifecycle spec); reading a call may use one extraction. Everything the
 * agents create is deleted afterwards, so the catalog and the desk are left as
 * they were found.
 */

const stamp = Date.now();
const PASSWORD = "GrantDesk-Synthetic-2026!";
const IIAL_LIKE = {
  email: `synthetic-iial-${stamp}@grantdesk.test`,
  client: `Synthetic Institute ${stamp}`,
};
const MULTI = {
  email: `synthetic-multi-${stamp}@grantdesk.test`,
  clients: [`Synthetic Ontario Nonprofit ${stamp}`, `Synthetic US Charity ${stamp}`],
};

const admin = createClient(
  process.env.SUPABASE_URL ?? "http://localhost:15535",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

test.afterAll(async () => {
  const { data: users } = await admin
    .from("consultants")
    .select("id")
    .in("email", [IIAL_LIKE.email, MULTI.email]);
  const ids = ((users ?? []) as Array<{ id: string }>).map((u) => u.id);
  if (ids.length) await admin.from("clients").delete().in("consultant_id", ids);
  // Deleting the auth user removes the consultant row with it (migration 0033).
  for (const id of ids) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.warn(`synthetic cleanup: could not delete ${id}: ${error.message}`);
  }
});

async function signUp(agent: DumbAgent, email: string) {
  await agent.open("/auth");
  await agent.type("Email", email);
  await agent.type("Password", PASSWORD);
  await agent.press("Create account");
  await expect(agent.page).toHaveURL(/\/clients$/, { timeout: 30_000 });
  agent.at("clients");
}

async function addClient(agent: DumbAgent, name: string) {
  agent.at("clients");
  await agent.type("Organization name", name);
  await agent.press("Add client");
  await agent.waitFor("Profile");
  agent.at(`client: ${name}`);
}

async function fillProfile(
  agent: DumbAgent,
  profile: {
    operatesIn: string;
    sectors: string;
    stage: string;
    budget: string;
    currency: string;
    leadTime: string;
    domains?: string;
    trackRecord: string;
    fundedPartner?: boolean;
    goDecision?: boolean;
  },
) {
  await agent.type("Operates in", profile.operatesIn);
  await agent.type("Sectors", profile.sectors);
  await agent.type("Stage", profile.stage);
  await agent.type("Annual budget", profile.budget);
  await agent.type("Budget currency", profile.currency);
  await agent.type("Lead time (weeks)", profile.leadTime);
  if (profile.domains) await agent.type("Capability domains", profile.domains);
  await agent.type("Track record", profile.trackRecord);
  if (profile.fundedPartner) await agent.tick(/funded partner/i);
  if (profile.goDecision) await agent.tick(/leadership go \/ no-go/i);
  await agent.press("Save profile");
  await agent.waitFor("Profile saved.");
  agent.need(
    "profile-ready",
    "Is the profile complete enough to match?",
    await textOf(agent.page, /Ready to match/),
  );
}

/** What the screen says matching `text`, waiting briefly the way a reader would. */
async function textOf(page: Page, text: RegExp, timeout = 15_000): Promise<string | null> {
  const el = page.getByText(text).first();
  try {
    await el.waitFor({ state: "visible", timeout });
  } catch {
    return null;
  }
  return ((await el.textContent()) ?? "").trim();
}

/** Opens the matches and waits for the run to report what it checked. */
async function findMatches(agent: DumbAgent) {
  await agent.press(/Find what they can apply for/);
  agent.at("matches");
  await agent.waitFor(/Checked \d+ calls/, 180_000);
  agent.need(
    "match-summary",
    "How many calls were checked, and how many can this client apply for?",
    await textOf(agent.page, /Checked \d+ calls/),
  );
}

test.describe.configure({ mode: "serial" });

test("a consultant screening calls for an institute that follows a go/no-go SOP", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const agent = new DumbAgent(page, "IIAL-style consultant");
  try {
    await signUp(agent, IIAL_LIKE.email);
    await addClient(agent, IIAL_LIKE.client);
    await fillProfile(agent, {
      operatesIn: "CA, CA-ON",
      sectors: "applied research, education, sustainability, supply chain",
      stage: "nonprofit",
      budget: "1.2M",
      currency: "CAD",
      leadTime: "4",
      domains: "supply chain, micro-credentials, applied research, smart cities, climate",
      trackRecord:
        "Applied research and professional education delivered with Ontario municipalities.",
      fundedPartner: true,
      goDecision: true,
    });
    await findMatches(agent);

    // ── What can this client apply for, and why ─────────────────────────────
    const canApply = agent.section(/^Can apply/);
    await expect(canApply, "there should be calls this client can apply for").toBeVisible();
    const card = canApply.locator("li").first();
    const cardText = (await card.textContent()) ?? "";
    agent.need(
      "call-title",
      "What is the call called?",
      await card.locator("a").first().textContent(),
    );
    agent.need(
      "call-funder-and-money",
      "Who funds it and for how much (or that it is not published)?",
      cardText.match(/[^·]+·\s*CA[^.]*/)?.[0] ?? cardText.slice(0, 160),
    );
    agent.need(
      "verdict-reason",
      "Why may this client apply — in a sentence?",
      await card.locator("p").nth(1).textContent(),
    );
    agent.need(
      "relevance-reason",
      "Why is it relevant to this client?",
      await textOf(page, /(funder's own text mentions|No shared wording)/),
    );
    agent.need(
      "rule-breakdown",
      "Which rules passed, failed or are unknown?",
      await card
        .getByText(/Eligibility|Timeline|Budget fit|Strategic fit/)
        .first()
        .textContent(),
    );

    // ── Narrowing the list like a person would ─────────────────────────────
    await agent.type(/Search title, summary or funder/, "Ontario");
    agent.need(
      "search-filter",
      "Can the list be narrowed by a word?",
      await canApply.getByRole("heading").first().textContent(),
    );
    await agent.type(/Search title, summary or funder/, "");
    await agent.choose("Closes", "90");
    agent.need(
      "deadline-filter",
      "Can the list show only what closes within 90 days?",
      await canApply.getByRole("heading").first().textContent(),
    );
    await agent.choose("Closes", "any");
    await agent.choose("Sort", "deadline");
    agent.need(
      "sort-by-deadline",
      "Can the list be ordered by closing date?",
      await canApply.locator("li").first().textContent(),
    );

    // ── Everything about one call, without leaving the app ──────────────────
    await canApply
      .getByRole("link", { name: /Draft this application/ })
      .first()
      .click();
    agent.at("call");
    await agent.waitFor("Opportunity Brief and go / no-go", 60_000);
    for (const [term, question] of [
      ["Funder", "Who is the funder?"],
      ["Status", "Is the call open?"],
      ["Award", "How much can be requested?"],
      ["Deadline", "When does it close, and how many days are left?"],
      ["Intake", "Is it a fixed deadline or rolling intake?"],
      ["Cost share", "Does the applicant have to contribute?"],
      ["Contact", "Who do I ask?"],
    ] as const) {
      agent.need(`snapshot-${term.toLowerCase()}`, question, await agent.fact(term));
    }
    agent.need(
      "guidelines",
      "Where are the guidelines and forms (or a statement that none are listed)?",
      await textOf(page, /(Guidelines and forms|The source lists none)/),
    );
    agent.need(
      "source-provenance",
      "Where did this information come from, and when was it confirmed?",
      await textOf(page, /^From .*(last confirmed|\.)/),
    );
    agent.need(
      "drafting-lock",
      "Does the page say drafting waits for leadership?",
      await textOf(page, /Leadership has not recorded a go/),
    );

    // ── Stage 3–4: the brief and the decision ───────────────────────────────
    await expect(page.getByRole("button", { name: "Save brief" })).toBeVisible({
      timeout: 180_000,
    });
    agent.need(
      "brief-prefill-intake",
      "Is the brief pre-filled with the intake type?",
      await page.getByLabel("Intake", { exact: true }).inputValue(),
    );
    await agent.type("Strategic angle", "Applied research capacity for Ontario partners.");
    await agent.choose("Decision", "go");
    await agent.type("Approved by", "Synthetic Leadership");
    await agent.type("Decision reason", "Fits applied research; runway is sufficient.");
    await agent.press("Save brief");
    await agent.waitFor("Brief and decision recorded.");
    agent.need(
      "decision-recorded",
      "Is the decision recorded with who approved it?",
      await textOf(page, /Decided .* approver Synthetic Leadership/),
    );
    agent.need(
      "drafting-unlocked",
      "Is drafting open after the GO?",
      (await page.getByText(/Leadership has not recorded a go/).count()) === 0 ? "unlocked" : null,
    );

    // ── What is due, across clients ────────────────────────────────────────
    await agent.press("What is due");
    agent.at("what is due");
    await agent.waitFor("What is due");
    agent.need(
      "due-list",
      "Does the call appear in what is due, with its client and decision?",
      await textOf(page, new RegExp(`${IIAL_LIKE.client}.*GO`)),
    );

    // ── The pipeline log ───────────────────────────────────────────────────
    await agent.press("Clients");
    await agent.press(IIAL_LIKE.client);
    agent.at("client");
    await expect(agent.section("Pipeline log")).toBeVisible();
    agent.need(
      "pipeline-log",
      "Is the decision kept in the pipeline log with who decided?",
      await agent.section("Pipeline log").textContent(),
    );
  } finally {
    const { missing, met, total } = agent.report();
    expect(missing, `${agent.persona}: ${met}/${total} needs met`).toEqual([]);
  }
});

test("a consultant juggling two clients in two countries", async ({ page }) => {
  test.setTimeout(420_000);
  const agent = new DumbAgent(page, "Multi-client consultant");
  try {
    await signUp(agent, MULTI.email);

    await addClient(agent, MULTI.clients[0]!);
    await fillProfile(agent, {
      operatesIn: "CA-ON",
      sectors: "community, youth, arts",
      stage: "nonprofit",
      budget: "300000",
      currency: "CAD",
      leadTime: "3",
      trackRecord: "Community arts and youth programs across Ontario since 2012.",
    });
    await findMatches(agent);

    // Ruled-out calls must say why, or the consultant cannot tell them from
    // calls that were never found.
    const ruledOut = agent.section(/^Ruled out/);
    if (await ruledOut.count()) {
      await ruledOut.getByRole("button", { name: /Show why/ }).click();
      agent.need(
        "rejection-reason",
        "Why was a call ruled out?",
        await ruledOut.locator("li p").nth(1).textContent(),
      );
    } else {
      agent.need(
        "rejection-reason",
        "Why was a call ruled out?",
        "nothing was ruled out for this profile",
      );
    }

    await agent.press("Clients");
    await addClient(agent, MULTI.clients[1]!);
    await fillProfile(agent, {
      operatesIn: "US",
      sectors: "health, community",
      stage: "charity",
      budget: "450k",
      currency: "USD",
      leadTime: "3",
      trackRecord: "Community health clinics in six US counties since 2011.",
    });
    await findMatches(agent);
    agent.need(
      "second-client-matches",
      "Does the second client get its own verdicts?",
      await agent
        .section(/^(Can apply|Needs an answer|Ruled out)/)
        .getByRole("heading")
        .first()
        .textContent(),
    );

    await agent.press("Clients");
    agent.at("clients");
    for (const name of MULTI.clients) {
      agent.need(
        `client-listed-${name.slice(10, 20)}`,
        `Is ${name} listed with where it operates?`,
        await textOf(page, new RegExp(`${name}.*(CA-ON|US)`)),
      );
    }

    await agent.press("Funder Coverage");
    agent.at("coverage");
    await agent.waitFor("Where our results come from");
    agent.need(
      "coverage-statement",
      "What does the catalog honestly cover, per market?",
      await textOf(page, /(open calls|no calls are ingested|refreshing|out of date)/),
    );
  } finally {
    const { missing, met, total } = agent.report();
    expect(missing, `${agent.persona}: ${met}/${total} needs met`).toEqual([]);
  }
});

test("a visitor deciding whether to sign in", async ({ page }) => {
  const agent = new DumbAgent(page, "First-time visitor");
  try {
    await agent.open("/");
    agent.need(
      "what-it-is",
      "What is this product?",
      await page.getByRole("heading").first().textContent(),
    );
    await textOf(page, /In the catalog right now/i);
    agent.need(
      "catalog-size",
      "How many calls does the catalog hold?",
      ((await agent.section(/In the catalog right now/i).textContent()) ?? "").match(
        /\d[\d,]*\s*open calls/,
      )?.[0],
    );
    agent.need(
      "sign-in",
      "Where do I sign in?",
      (await page.getByRole("link", { name: "Sign in" }).count()) ? "Sign in link" : null,
    );
    await agent.press("Sign in");
    agent.at("sign-in");
    const create = page.getByRole("button", { name: "Create account" });
    const shown = await create
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    agent.need(
      "sign-in-form",
      "Can I sign in or create an account?",
      shown ? "Create account button" : null,
    );
  } finally {
    const { missing, met, total } = agent.report();
    expect(missing, `${agent.persona}: ${met}/${total} needs met`).toEqual([]);
  }
});
