import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { readRequirementsForGrant } from "../../src/server/read-requirements";
import { sourceHash } from "../../src/server/ingest";

/**
 * A real call that reads but extracts nothing structured — not a mock, a
 * genuine advisory-service page with no application form — used to be a dead
 * end: the server returned a failure, and the proposal page's own "add a
 * section below" form was gated behind requirements already existing, so a
 * consultant could never reach it. Both are fixed; this proves the server
 * half from a live fetch, since a createServerFn export cannot be called
 * outside TanStack Start's own request context to test it that way.
 */

const URL = process.env.SUPABASE_URL ?? "http://localhost:15535";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin: SupabaseClient = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stamp = Date.now();
const SOURCE_KEY = `test-source-readreq-${stamp}`;

let grantId: string;
let processGrantId: string;

beforeAll(async () => {
  expect(SERVICE_KEY, "SUPABASE_SERVICE_ROLE_KEY must be set — is .env loaded?").not.toBe("");

  const { data: funder, error: funderError } = await admin
    .from("funders")
    .upsert({ name: `Advisory Service ${stamp}`, country: "CA" }, { onConflict: "name,country" })
    .select("id")
    .single();
  if (funderError) throw funderError;

  // A live government advisory page: real prose, no application form, no
  // stated requirements — the honest shape of a "read but nothing to extract"
  // result, not a broken fetch. Ingested once here rather than reused from
  // the seeded catalog so this test does not depend on that data existing.
  const { data: grant, error: grantError } = await admin
    .from("grants")
    .upsert(
      {
        funder_id: (funder as { id: string }).id,
        title: `Advisory Service ${stamp}`,
        url: "https://ised-isde.canada.ca/site/accelerated-growth-service/en/innovation-advisors",
        country: "CA",
        language: "en",
        source_key: SOURCE_KEY,
        source_hash: sourceHash(SOURCE_KEY, `advisory-${stamp}`),
      },
      { onConflict: "source_hash" },
    )
    .select("id")
    .single();
  if (grantError) throw grantError;
  grantId = (grant as { id: string }).id;

  // A real ACOA-family page: one line of substance ("Contact your nearest
  // office...") that the extractor used to file under "section" — the kind
  // the drafting pipeline writes narrative prose for. It produced exactly
  // what that instruction is not: a paragraph elaborating on a procedural
  // step, restating "we will contact them, we will fill in the form" with
  // nothing added. Same funder shape, ingested separately from the
  // no-extraction grant above so each test owns one clean fixture.
  const { data: processGrant, error: processGrantError } = await admin
    .from("grants")
    .upsert(
      {
        funder_id: (funder as { id: string }).id,
        title: `Regional Growth Program ${stamp}`,
        url: "https://www.canada.ca/en/atlantic-canada-opportunities/services/regional-economic-growth-through-innovation.html",
        country: "CA",
        language: "en",
        source_key: SOURCE_KEY,
        source_hash: sourceHash(SOURCE_KEY, `process-${stamp}`),
      },
      { onConflict: "source_hash" },
    )
    .select("id")
    .single();
  if (processGrantError) throw processGrantError;
  processGrantId = (processGrant as { id: string }).id;
}, 60_000);

describe("readRequirementsForGrant", () => {
  it("returns what it read instead of failing, when nothing structured is there", async () => {
    const result = await readRequirementsForGrant(admin, grantId);
    expect(result.found).toBe(false);
    if (result.found) throw new Error("unreachable");
    expect(result.readText.length).toBeGreaterThan(200);

    // Nothing gets written for a call with nothing to write — a stray row
    // here would be indistinguishable from a real, if sparse, extraction.
    const { data: stored } = await admin.from("requirements").select("id").eq("grant_id", grantId);
    expect(stored).toHaveLength(0);
  }, 30_000);

  it("classifies how a call is submitted as 'process', never a drafted section", async () => {
    const result = await readRequirementsForGrant(admin, processGrantId);
    expect(result.found).toBe(true);

    const { data: stored } = await admin
      .from("requirements")
      .select("label, kind")
      .eq("grant_id", processGrantId);
    // The exact heading is the model's own wording and varies run to run —
    // one pass called it "How to apply", another split it into "Initial
    // Project Discussion" and "Application for Financial Assistance". What
    // has to hold regardless of wording is the classification: something
    // describing the mechanics of applying must never come back as
    // "section", the kind the drafting pipeline writes narrative prose for.
    const processItems = (stored ?? []).filter((r) => r.kind === "process");
    expect(
      processItems.length,
      `no process-kind requirement found: ${JSON.stringify(stored)}`,
    ).toBeGreaterThan(0);
    // "Application for Financial Assistance" could honestly land as
    // "attachment" (it is also literally a form to fill in) — the one kind
    // it must never be is "section", which is what sent this to the drafting
    // model as narrative prose to elaborate on in the first place.
    const contactOrSubmitSteps = (stored ?? []).filter((r) =>
      /how to apply|initial.*discussion|contact.*office/i.test(r.label),
    );
    for (const item of contactOrSubmitSteps) {
      expect(item.kind, `"${item.label}" was classified as ${item.kind}`).not.toBe("section");
    }
  }, 30_000);
});
