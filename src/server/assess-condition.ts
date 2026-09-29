import type { SupabaseClient } from "@supabase/supabase-js";
import { callLlm } from "./llm";
import { UNTRUSTED_RULE, untrusted } from "./prompt-safety";
import { NoProfileError } from "./draft";

/**
 * Read a funder's own condition against a client's profile, and say plainly
 * what matches and what is still unclear.
 *
 * This is not the rules engine, and it is not trying to be. The six
 * structured rules in src/lib/eligibility.ts decide a verdict from fields we
 * store — country, deadline, applicant type — and they stay deterministic on
 * purpose. A condition like ACOA's "Who can apply?" is a full paragraph of
 * funder prose the rules engine never sees; extraction already keeps it
 * verbatim as a `sourceQuote`, and until now a consultant had to hold their
 * client's whole profile in their head and re-read it against that paragraph
 * themselves, for every critical condition, on every call. That is exactly
 * the kind of manual re-checking worth automating — but only the *reading*.
 * The confirmation checkbox stays a person's, because the rules engine's own
 * design principle applies here too: a model may explain, it may not decide.
 */

export type AssessableCondition = {
  label: string;
  detail: string | null;
  sourceQuote: string | null;
};

export type ConditionProfile = {
  name: string;
  sectors: string[] | null;
  jurisdictions: string[] | null;
  stage: string | null;
  capabilities: string | null;
};

const SYSTEM = `You help a grants consultant read one funder condition against their client's own profile.

You do not decide eligibility. State only what the client's profile actually
says, matched against the condition's own wording:
- Name the specific phrase in the condition the client's profile appears to
  satisfy, quoting the client's own fact that supports it.
- Name anything the condition asks for that the profile does not state —
  "the profile does not say whether..." is a correct, useful answer, not a
  weak one.
- Never invent a fact about the client that is not in the profile given to
  you. If the profile is too thin to say anything, say exactly that.

Two or three sentences. No preamble, no "Based on the information provided".
Address the consultant directly ("This client's profile states...").

${UNTRUSTED_RULE}`;

function buildPrompt(condition: AssessableCondition, client: ConditionProfile): string {
  const quote = condition.sourceQuote ?? condition.detail ?? condition.label;
  const profile = [
    `Organization: ${client.name}`,
    client.stage ? `Stage: ${client.stage}` : null,
    client.sectors?.length ? `Sectors: ${client.sectors.join(", ")}` : null,
    client.jurisdictions?.length ? `Operates in: ${client.jurisdictions.join(", ")}` : null,
    client.capabilities ? `Track record: ${client.capabilities}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return [
    "Condition:",
    untrusted(`funder condition: ${condition.label}`, quote),
    "",
    "Client profile:",
    untrusted("client profile", profile),
  ].join("\n");
}

export type ConditionAssessment = { assessment: string; model: string };

export async function assessCondition(
  supabase: SupabaseClient,
  clientId: string,
  condition: AssessableCondition,
): Promise<ConditionAssessment> {
  const { data: clientRow, error } = await supabase
    .from("clients")
    .select("name, client_profiles(sectors, jurisdictions, stage, capabilities)")
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw new Error(`could not read the client: ${error.message}`);
  if (!clientRow) throw new NoProfileError();

  const row = clientRow as unknown as {
    name: string;
    client_profiles: {
      sectors: string[] | null;
      jurisdictions: string[] | null;
      stage: string | null;
      capabilities: string | null;
    } | null;
  };
  const profile = row.client_profiles;
  if (!profile || (!profile.capabilities && !profile.sectors?.length)) throw new NoProfileError();

  const client: ConditionProfile = {
    name: row.name,
    sectors: profile.sectors,
    jurisdictions: profile.jurisdictions,
    stage: profile.stage,
    capabilities: profile.capabilities,
  };

  const response = await callLlm(
    {
      role: "judge",
      temperature: 0.2,
      maxTokens: 700,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildPrompt(condition, client) },
      ],
      validate: (candidate) => candidate.trim().length > 20,
    },
    { timeoutMs: 60_000 },
  );

  return { assessment: response.text.trim(), model: `${response.provider}/${response.model}` };
}
