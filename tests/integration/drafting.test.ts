import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { draftSection, findReusableAnswers, saveAnswer } from "../../src/server/draft";
import { embedPendingAnswers } from "../../src/server/embed";
import { sourceHash } from "../../src/server/ingest";

/**
 * Phase 4's claim: a proposal drafts against a real call's requirements, and
 * what the consultant already wrote gets reused.
 *
 * The split matters. *Whether reuse happens* is decidable and lives here — an
 * answer stored under one funder's wording must be found when a different
 * funder asks the same thing in different words. *How good the resulting prose
 * is* is a distribution, and lives in tests/evals/drafting.eval.ts.
 */

const URL = process.env.SUPABASE_URL ?? "http://localhost:15535";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const stamp = Date.now();
const SOURCE_KEY = `test-source-draft-${stamp}`;
const CREDS = { email: `draft-${stamp}@grantdesk.test`, password: "GrantDesk-Test-2026!" };

/** A fact no model would produce on its own, so its presence proves reuse. */
const DISTINCTIVE = "the Wentworth Ravine restoration, completed in 2019 with 312 volunteers";

const admin = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let consultant: SupabaseClient;
let clientId: string;
let grantId: string;
let proposalId: string;
let requirementId: string;

beforeAll(async () => {
  expect(ANON, "SUPABASE_ANON_KEY must be set — is .env loaded?").not.toBe("");

  consultant = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signUpError } = await consultant.auth.signUp(CREDS);
  if (signUpError && !/already registered/i.test(signUpError.message)) throw signUpError;
  const { data: session, error: signInError } = await consultant.auth.signInWithPassword(CREDS);
  if (signInError) throw signInError;

  const { data: client, error: clientError } = await consultant
    .from("clients")
    .insert({ consultant_id: session.user!.id, name: `Ravine Keepers ${stamp}`, country: "CA" })
    .select("id")
    .single();
  if (clientError) throw clientError;
  clientId = client.id as string;

  const { error: profileError } = await consultant.from("client_profiles").upsert({
    client_id: clientId,
    sectors: ["environment", "community"],
    jurisdictions: ["CA-ON"],
    stage: "nonprofit",
    annual_budget: 450_000,
    capabilities: "We restore urban ravines and run volunteer planting days.",
    beneficiaries: "residents of low-income neighbourhoods",
  });
  if (profileError) throw profileError;

  const { data: funder } = await admin
    .from("funders")
    .upsert(
      { name: `Draft Fixture Funder ${stamp}`, country: "CA", source_key: SOURCE_KEY },
      { onConflict: "name,country" },
    )
    .select("id")
    .single();

  const { data: grant, error: grantError } = await admin
    .from("grants")
    .upsert(
      {
        funder_id: funder!.id,
        title: "Urban Greening Fund",
        summary: "Supports nonprofits restoring green space in cities.",
        url: "https://example.org/urban-greening",
        country: "CA",
        currency: "CAD",
        deadline: "2099-12-31",
        language: "en",
        source_key: SOURCE_KEY,
        source_hash: sourceHash(SOURCE_KEY, "urban-greening"),
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "source_hash" },
    )
    .select("id")
    .single();
  if (grantError) throw grantError;
  grantId = grant.id as string;

  // The funder's own wording, deliberately different from how the stored
  // answer below is labelled.
  const { data: requirement, error: requirementError } = await consultant
    .from("requirements")
    .upsert(
      {
        grant_id: grantId,
        client_id: clientId,
        label: "Organizational Capacity",
        detail: "Demonstrate your ability to deliver projects of this size.",
        kind: "section",
        word_limit: 300,
        evaluation_note: "Scored on evidence of comparable completed work.",
        source_quote: "Applicants must demonstrate organizational capacity.",
        sort_order: 0,
      },
      { onConflict: "grant_id, label, client_id" },
    )
    .select("id")
    .single();
  if (requirementError) throw requirementError;
  requirementId = requirement.id as string;

  const { data: proposal, error: proposalError } = await consultant
    .from("proposals")
    .upsert({ client_id: clientId, grant_id: grantId }, { onConflict: "client_id, grant_id" })
    .select("id")
    .single();
  if (proposalError) throw proposalError;
  proposalId = proposal.id as string;
}, 120_000);

afterAll(async () => {
  await admin.from("grants").delete().eq("source_key", SOURCE_KEY);
  await admin.from("funders").delete().eq("source_key", SOURCE_KEY);
  await admin.from("clients").delete().eq("id", clientId);
});

describe("the answer library", () => {
  it("finds a stored answer when a funder asks the same thing in different words", async () => {
    // Stored as "Track record and past projects"; the call asks for
    // "Organizational Capacity". A label match finds nothing here, which is
    // exactly why reuse is by meaning.
    await saveAnswer(
      consultant,
      clientId,
      "Track record and past projects",
      `Since 2011 we have delivered eleven restoration projects, including ${DISTINCTIVE}.`,
    );

    const found = await findReusableAnswers(consultant, clientId, {
      id: requirementId,
      label: "Organizational Capacity",
      detail: "Demonstrate your ability to deliver projects of this size.",
      wordLimit: 300,
      evaluationNote: null,
      sourceQuote: null,
    });

    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.content).toContain("Wentworth Ravine");
  }, 60_000);

  it("recovers an answer that was stored while the embedder was unreachable", async () => {
    // saveAnswer keeps the consultant's work even when the local model is down
    // — losing what they wrote would be far worse. But nothing came back for
    // those rows, so one bad minute excluded an answer from reuse permanently
    // and the library quietly stopped being worth anything for that client.
    const { data: stranded } = await consultant
      .from("answer_library")
      .insert({
        client_id: clientId,
        label: "Community partnerships",
        content: "We co-deliver ravine restoration with four neighbourhood associations.",
        embedding: null,
      })
      .select("id")
      .single();
    const strandedId = (stranded as { id: string }).id;

    const { data: beforeMatch } = await consultant.rpc("match_answers", {
      target_client: clientId,
      q_embedding: JSON.stringify(new Array(768).fill(0.01)),
      max_results: 50,
      min_similarity: -1,
    });
    // Invisible to reuse while its embedding is null, whatever the threshold.
    expect((beforeMatch as Array<{ id: string }>).map((a) => a.id)).not.toContain(strandedId);

    const { embedded } = await embedPendingAnswers(consultant);
    expect(embedded).toBeGreaterThan(0);

    const { data: after } = await consultant
      .from("answer_library")
      .select("embedding")
      .eq("id", strandedId)
      .single();
    expect(after!.embedding).not.toBeNull();

    await consultant.from("answer_library").delete().eq("id", strandedId);
  }, 120_000);

  it("stops reusing an answer once the consultant removes it", async () => {
    // The reason the library needed a visible surface at all: a stored answer
    // is fed to the model as approved fact on every future draft, so a wrong
    // figure kept here reappears in proposal after proposal. Removal has to
    // actually take it out of the reuse pool, not just hide it.
    const target = {
      id: requirementId,
      label: "Organizational Capacity",
      detail: "Demonstrate your ability to deliver projects of this size.",
      wordLimit: 300,
      evaluationNote: null,
      sourceQuote: null,
    };

    // Its own answer, not the shared fixture: deleting that one would leave
    // every later test in this file with nothing to reuse, and a suite whose
    // tests depend on each other's leftovers fails for reasons nobody can read.
    const doomed = await saveAnswer(
      consultant,
      clientId,
      "Capacity to deliver at this size",
      "We have delivered eleven comparable restoration projects since 2011, each managed in house.",
    );

    const before = await findReusableAnswers(consultant, clientId, target);
    expect(before.map((a) => a.id)).toContain(doomed.id);

    const { error: deleteError } = await consultant
      .from("answer_library")
      .delete()
      .eq("id", doomed.id);
    expect(deleteError).toBeNull();

    const after = await findReusableAnswers(consultant, clientId, target);
    expect(after.map((a) => a.id)).not.toContain(doomed.id);
    // ...and the rest of the library is untouched.
    expect(after.length).toBeGreaterThan(0);
  }, 90_000);

  it("does not surface one client's answer in another client's proposal", async () => {
    const { data: other } = await consultant
      .from("clients")
      .insert({
        consultant_id: (await consultant.auth.getUser()).data.user!.id,
        name: `Unrelated ${stamp}`,
        country: "CA",
      })
      .select("id")
      .single();

    const found = await findReusableAnswers(consultant, (other as { id: string }).id, {
      id: requirementId,
      label: "Organizational Capacity",
      detail: null,
      wordLimit: null,
      evaluationNote: null,
      sourceQuote: null,
    });

    // A consultant's whole business depends on this never happening.
    expect(found).toEqual([]);
    await consultant
      .from("clients")
      .delete()
      .eq("id", (other as { id: string }).id);
  }, 60_000);
});

describe("drafting", () => {
  it("drafts against the requirement and records what it reused", async () => {
    const result = await draftSection(consultant, clientId, {
      id: requirementId,
      label: "Organizational Capacity",
      detail: "Demonstrate your ability to deliver projects of this size.",
      wordLimit: 300,
      evaluationNote: "Scored on evidence of comparable completed work.",
      sourceQuote: "Applicants must demonstrate organizational capacity.",
    });

    expect(result.content.length).toBeGreaterThan(100);
    expect(result.wordCount).toBeGreaterThan(20);
    // Provenance: a draft nobody can attribute has to be re-verified from
    // scratch, which costs more than writing it did.
    expect(result.draftedBy).toMatch(/\w+\/\w+/);
    expect(result.reusedAnswers.length).toBeGreaterThan(0);
    // fabrications() itself is proven separately (tests/evals/drafting.eval.ts,
    // src/lib/fabrication.test.ts); the point here is that a real draft, from
    // real profile facts and a real answer, actually gets run through it —
    // draftSection wired it in for the first time this session.
    expect(Array.isArray(result.fabrications)).toBe(true);
  }, 180_000);

  it("counts each reuse, so the library can show what earns its keep", async () => {
    // times_used sat in the schema from the start and was never incremented,
    // which left the one question the library exists to answer with no data
    // behind it.
    const { data: before } = await consultant
      .from("answer_library")
      .select("id, times_used")
      .eq("client_id", clientId)
      .order("times_used", { ascending: false })
      .limit(1)
      .single();

    await draftSection(consultant, clientId, {
      id: requirementId,
      label: "Organizational Capacity",
      detail: "Demonstrate your ability to deliver projects of this size.",
      wordLimit: 300,
      evaluationNote: null,
      sourceQuote: null,
    });

    const { data: after } = await consultant
      .from("answer_library")
      .select("times_used, last_used_at")
      .eq("id", (before as { id: string }).id)
      .single();

    expect(after!.times_used).toBeGreaterThan((before as { times_used: number }).times_used);
    expect(after!.last_used_at).not.toBeNull();
  }, 180_000);

  it("refuses to draft for a client it knows nothing about", async () => {
    const { data: blank } = await consultant
      .from("clients")
      .insert({
        consultant_id: (await consultant.auth.getUser()).data.user!.id,
        name: `Blank ${stamp}`,
        country: "CA",
      })
      .select("id")
      .single();

    // Drafting from an empty profile produces confident text about an
    // organization we know nothing about — the most damaging thing this
    // product could hand a consultant.
    await expect(
      draftSection(consultant, (blank as { id: string }).id, {
        id: requirementId,
        label: "Organizational Capacity",
        detail: null,
        wordLimit: null,
        evaluationNote: null,
        sourceQuote: null,
      }),
    ).rejects.toThrow("no_profile");

    await consultant
      .from("clients")
      .delete()
      .eq("id", (blank as { id: string }).id);
  }, 60_000);

  it("stores the section against its requirement, with its provenance", async () => {
    const { error } = await consultant.from("proposal_sections").upsert(
      {
        proposal_id: proposalId,
        requirement_id: requirementId,
        heading: "Organizational Capacity",
        content: "Drafted content.",
        word_count: 2,
        drafted_by: "test/fixture",
        sort_order: 0,
      },
      { onConflict: "proposal_id, requirement_id" },
    );
    expect(error).toBeNull();

    const { count } = await consultant
      .from("proposal_sections")
      .select("id", { count: "exact", head: true })
      .eq("proposal_id", proposalId)
      .eq("requirement_id", requirementId);
    // Re-drafting must replace the section, not append a second copy of it.
    expect(count).toBe(1);
  });
});
