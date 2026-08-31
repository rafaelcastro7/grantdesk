import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { assessCondition } from "../../src/server/assess-condition";
import { NoProfileError } from "../../src/server/draft";

/**
 * Phase 6's claim, and the user complaint that motivated it: re-reading a
 * funder's own eligibility paragraph against a client's profile by hand, for
 * every critical condition on every call, was exactly the manual work worth
 * automating — as long as it only reads, and never decides on its own.
 */

const URL = process.env.SUPABASE_URL ?? "http://localhost:15535";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";

const stamp = Date.now();
const CREDS = { email: `assess-${stamp}@grantdesk.test`, password: "GrantDesk-Test-2026!" };

/** A fact deliberately absent from the profile: nothing here should mention it. */
const NEVER_STATED = "carbon capture";

let consultant: SupabaseClient;
let clientId: string;
let thinClientId: string;

beforeAll(async () => {
  expect(ANON, "SUPABASE_ANON_KEY must be set — is .env loaded?").not.toBe("");

  consultant = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
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
  clientId = (client as { id: string }).id;

  const { error: profileError } = await consultant.from("client_profiles").upsert({
    client_id: clientId,
    sectors: ["environment", "community"],
    jurisdictions: ["CA-ON"],
    stage: "nonprofit",
    capabilities: "We restore urban ravines and run volunteer planting days.",
  });
  if (profileError) throw profileError;

  const { data: thinClient, error: thinError } = await consultant
    .from("clients")
    .insert({ consultant_id: session.user!.id, name: `Unprofiled ${stamp}`, country: "CA" })
    .select("id")
    .single();
  if (thinError) throw thinError;
  thinClientId = (thinClient as { id: string }).id;
}, 30_000);

describe("assessCondition", () => {
  it("names the client's own fact that satisfies the funder's condition", async () => {
    const result = await assessCondition(consultant, clientId, {
      label: "Who can apply?",
      detail: null,
      sourceQuote:
        "Open to registered non-profit organizations working in environmental restoration or community development.",
    });
    // Not asserting exact wording — a model's phrasing varies — only that it
    // actually grounded the answer in this client's real, stated facts.
    expect(result.assessment.toLowerCase()).toMatch(/nonprofit|non-profit/);
    expect(result.assessment.toLowerCase()).toMatch(/environment|ravine|community/);
    expect(result.model).toMatch(/\//);
  }, 30_000);

  it("says the profile does not state a fact, rather than inventing that it does", async () => {
    const result = await assessCondition(consultant, clientId, {
      label: "Technical focus",
      detail: null,
      sourceQuote: `Priority given to applicants with ${NEVER_STATED} expertise.`,
    });
    // Naming the condition's own phrase back is expected and correct — the
    // system prompt asks for exactly that when the profile is silent on it.
    // What must never happen is claiming the profile confirms it.
    const text = result.assessment.toLowerCase();
    expect(text).toMatch(/does not (state|say|mention)|no mention|not (stated|mentioned)|unclear/);
    expect(text).not.toMatch(
      /(profile|client) (states|confirms|has|shows).{0,40}carbon capture/,
    );
  }, 30_000);

  it("refuses to guess against a profile too thin to say anything", async () => {
    await expect(
      assessCondition(consultant, thinClientId, {
        label: "Who can apply?",
        detail: null,
        sourceQuote: "Open to registered non-profits.",
      }),
    ).rejects.toBeInstanceOf(NoProfileError);
  }, 30_000);
});
