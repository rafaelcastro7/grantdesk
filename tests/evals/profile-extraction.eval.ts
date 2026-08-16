/**
 * Eval — not a test.
 *
 * Phase 1 rests on one claim: a consultant can get a usable client profile in
 * minutes from material they already have. A model's answer is a distribution,
 * so the question is not "does it equal X" but "how often is it good enough to
 * match against, and where does it fail".
 *
 * Pass criterion per case: the extracted profile satisfies assessProfile().canMatch
 * — both required fields present — and the jurisdictions include the expected
 * country. That is the real bar: anything less and matching cannot honour the
 * product's promise.
 *
 * Usage: bun run eval:profile
 */

import { config } from "dotenv";
import { extractProfileFromUrl } from "../../src/server/extract-profile";
import { assessProfile } from "../../src/lib/profile-completeness";

config({ path: ".env" });

type Case = {
  name: string;
  url: string;
  expectCountry: string;
  /** At least one of these should appear, loosely matched. */
  expectSectorLike: string[];
};

// Real, public, stable organization pages. Deliberately varied: a research
// network, a startup hub, and a small nonprofit — the three shapes a
// consultant's client list actually contains.
const CASES: Case[] = [
  {
    name: "Mitacs (research network)",
    url: "https://www.mitacs.ca/about/",
    expectCountry: "CA",
    expectSectorLike: ["research", "innovation", "education", "technology"],
  },
  {
    name: "MaRS Discovery District (innovation hub)",
    url: "https://www.marsdd.com/about/",
    expectCountry: "CA",
    expectSectorLike: ["innovation", "technology", "health", "cleantech", "clean-tech"],
  },
  {
    name: "Evergreen (environmental nonprofit)",
    url: "https://www.evergreen.ca/about-us/",
    expectCountry: "CA",
    expectSectorLike: ["environment", "sustainability", "community", "urban", "clean-tech"],
  },
];

const looselyIncludes = (haystack: string[], needles: string[]) =>
  haystack.some((h) => needles.some((n) => h.toLowerCase().includes(n.toLowerCase())));

let passed = 0;
const rows: string[] = [];

for (const testCase of CASES) {
  const started = Date.now();
  try {
    const { profile, provenance } = await extractProfileFromUrl(testCase.url);
    const completeness = assessProfile(profile);

    const countryOk = (profile.jurisdictions ?? []).some((j) =>
      j.toUpperCase().startsWith(testCase.expectCountry),
    );
    const sectorOk = looselyIncludes(profile.sectors ?? [], testCase.expectSectorLike);
    const ok = completeness.canMatch && countryOk;

    if (ok) passed++;
    rows.push(
      [
        ok ? "PASS" : "FAIL",
        testCase.name,
        `${Date.now() - started}ms`,
        `score=${completeness.score}`,
        `canMatch=${completeness.canMatch}`,
        `country=${countryOk}`,
        `sector=${sectorOk}`,
        `via ${provenance.model}`,
        `sectors=[${(profile.sectors ?? []).join(",")}]`,
        `jurisdictions=[${(profile.jurisdictions ?? []).join(",")}]`,
      ].join("  "),
    );
  } catch (error) {
    rows.push(
      `ERR   ${testCase.name}  ${Date.now() - started}ms  ${
        error instanceof Error ? error.message.slice(0, 160) : String(error)
      }`,
    );
  }
}

console.log("\nProfile extraction eval\n" + "=".repeat(78));
for (const row of rows) console.log(row);
console.log("=".repeat(78));
console.log(`${passed}/${CASES.length} usable for matching`);

// A single flaky page should not fail the phase, but a majority failure means
// the Phase 1 assumption is wrong and the plan changes here.
process.exit(passed >= Math.ceil(CASES.length / 2) ? 0 : 1);
