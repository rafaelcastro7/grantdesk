import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * A deliberately dumb user.
 *
 * It knows nothing about the code: no test ids, no CSS, no URLs beyond the
 * front door. It reads what is on screen and acts on what a person would —
 * a button's name, a field's label, a heading. If it cannot find something
 * that way, a consultant probably cannot either, and that is the finding.
 *
 * Every piece of information a grant manager needs is recorded as a "need":
 * found or not, with the words the screen actually showed. The report is
 * written whether the mission succeeds or not, so a failure says exactly
 * which need went unmet and where the agent was looking.
 */

export type Need = {
  key: string;
  question: string;
  screen: string;
  found: boolean;
  evidence: string;
};

export class DumbAgent {
  readonly needs: Need[] = [];
  readonly steps: string[] = [];
  private screen = "start";

  constructor(
    readonly page: Page,
    readonly persona: string,
  ) {}

  private log(step: string) {
    this.steps.push(`[${this.screen}] ${step}`);
  }

  /** The only addresses it types: the front door and the sign-in page. */
  async open(path: "/" | "/auth") {
    await this.page.goto(path);
    await expect(this.page.locator("html[data-hydrated='true']")).toBeAttached({ timeout: 60_000 });
    this.screen = path === "/" ? "home" : "sign-in";
    this.log(`opened ${path}`);
  }

  at(screen: string) {
    this.screen = screen;
  }

  /** Clicks whatever button or link carries this visible name. */
  async press(name: string | RegExp) {
    const target = this.page
      .getByRole("button", { name })
      .or(this.page.getByRole("link", { name }))
      .first();
    await expect(target, `${this.persona} looked for "${name}" on ${this.screen}`).toBeVisible({
      timeout: 30_000,
    });
    await target.click();
    this.log(`pressed "${name}"`);
  }

  async type(label: string | RegExp, value: string) {
    const field = this.page.getByLabel(label, { exact: typeof label === "string" }).first();
    await expect(field, `${this.persona} looked for the "${label}" field`).toBeVisible();
    await field.fill(value);
    this.log(`typed into "${label}"`);
  }

  async choose(label: string | RegExp, option: string) {
    const field = this.page.getByLabel(label, { exact: typeof label === "string" }).first();
    await expect(field, `${this.persona} looked for the "${label}" list`).toBeVisible({
      timeout: 15_000,
    });
    await field.selectOption(option, { timeout: 15_000 });
    this.log(`chose "${option}" in "${label}"`);
  }

  async tick(label: string | RegExp) {
    const box = this.page.getByLabel(label).first();
    await expect(box, `${this.persona} looked for the "${label}" box`).toBeVisible({
      timeout: 15_000,
    });
    if (!(await box.isChecked())) await box.check();
    this.log(`ticked "${label}"`);
  }

  /** Waits for words to appear, the way a person waits for a page to settle. */
  async waitFor(text: string | RegExp, timeout = 60_000) {
    await expect(
      this.page.getByText(text).first(),
      `${this.persona} waited for "${text}"`,
    ).toBeVisible({
      timeout,
    });
  }

  /** A section, found the way a reader finds one: by its heading. */
  section(heading: string | RegExp): Locator {
    return this.page
      .locator("section")
      .filter({ has: this.page.getByRole("heading", { name: heading }) })
      .first();
  }

  /** The value printed next to a label in a list of facts (dt / dd). */
  async fact(term: string): Promise<string | null> {
    const dt = this.page.locator("dt", { hasText: new RegExp(`^${term}$`, "i") }).first();
    if (!(await dt.count())) return null;
    const dd = dt.locator("xpath=following-sibling::dd[1]");
    return ((await dd.textContent()) ?? "").trim() || null;
  }

  /**
   * Records whether a need was met. `evidence` is what the screen said; an
   * empty or placeholder value ("undefined", "NaN", "null") counts as not met.
   */
  need(key: string, question: string, evidence: string | null | undefined) {
    const text = (evidence ?? "").replace(/\s+/g, " ").trim();
    const found = text.length > 0 && !/\b(undefined|NaN|null|Invalid Date)\b/.test(text);
    this.needs.push({ key, question, screen: this.screen, found, evidence: text.slice(0, 300) });
    this.log(`${found ? "found" : "MISSING"} ${key}`);
  }

  report(dir = "test-results/synthetic-agents"): { met: number; total: number; missing: Need[] } {
    mkdirSync(dir, { recursive: true });
    const missing = this.needs.filter((n) => !n.found);
    const slug = this.persona.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    writeFileSync(
      join(dir, `${slug}.json`),
      JSON.stringify({ persona: this.persona, needs: this.needs, steps: this.steps }, null, 2),
    );
    const lines = [
      `# ${this.persona}`,
      "",
      `${this.needs.length - missing.length} of ${this.needs.length} needs met.`,
      "",
      "| Need | Screen | Found | What the screen said |",
      "| --- | --- | --- | --- |",
      ...this.needs.map(
        (n) =>
          `| ${n.question} | ${n.screen} | ${n.found ? "yes" : "**NO**"} | ${n.evidence.replace(/\|/g, "/")} |`,
      ),
    ];
    writeFileSync(join(dir, `${slug}.md`), lines.join("\n"));
    return { met: this.needs.length - missing.length, total: this.needs.length, missing };
  }
}
