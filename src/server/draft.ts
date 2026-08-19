import type { SupabaseClient } from "@supabase/supabase-js";
import { callLlm } from "./llm";
import { ANSWER_EMBED_MODEL, embedOne } from "./embed";

/**
 * Draft one section, against one requirement.
 *
 * Two things make this different from asking a model for a grant proposal.
 *
 * First, the prompt is built from what *this* funder asked for — their heading,
 * their word limit, their stated evaluation criteria — rather than a generic
 * outline. A template produces text that is fluent and answers nobody's
 * question, which is exactly the work a consultant then has to redo.
 *
 * Second, the client's own previously written answers are retrieved and given
 * to the model as the material to work from. This is where the promised time
 * saving actually comes from: a consultant writes their organizational history
 * once, and every later call reuses it. It also holds the draft to facts the
 * consultant already approved, rather than facts a model found plausible.
 */

export type DraftRequirement = {
  id: string;
  label: string;
  detail: string | null;
  wordLimit: number | null;
  evaluationNote: string | null;
  sourceQuote: string | null;
};

export type DraftClient = {
  id: string;
  name: string;
  sectors: string[] | null;
  jurisdictions: string[] | null;
  stage: string | null;
  annualBudget: number | null;
  capabilities: string | null;
  beneficiaries: string | null;
};

export type ReusedAnswer = { id: string; label: string; content: string; similarity: number };

export type DraftResult = {
  content: string;
  wordCount: number;
  reusedAnswers: ReusedAnswer[];
  draftedBy: string;
  /**
   * What the chain tried before this answer. Empty on a healthy call.
   *
   * Carried up because a draft written by the local fallback is a different
   * product from one written by the intended model, and for weeks nothing
   * anywhere said which had happened.
   */
  attempts: string[];
};

/**
 * Tokens a reasoning model spends before producing any visible output.
 *
 * Measured against gpt-oss-120b on a real section prompt: ~700 tokens of
 * reasoning, nothing visible below a 1500-token ceiling. This is deliberately
 * generous — an over-budget request costs nothing when the model stops on its
 * own, while an under-budget one costs the whole call.
 */
const REASONING_HEADROOM = 1200;

export class NoProfileError extends Error {
  constructor() {
    super("no_profile");
    this.name = "NoProfileError";
  }
}

/**
 * Stored answers closest in meaning to this requirement.
 *
 * By meaning rather than by label, because every funder asks the same question
 * in different words — "organizational capacity", "track record" and "prior
 * experience" are one answer, and a text match finds none of them.
 */
export async function findReusableAnswers(
  supabase: SupabaseClient,
  clientId: string,
  requirement: DraftRequirement,
): Promise<ReusedAnswer[]> {
  const query = [requirement.label, requirement.detail].filter(Boolean).join(". ");
  if (!query) return [];

  let embedding: number[];
  try {
    embedding = await embedOne(query, ANSWER_EMBED_MODEL);
  } catch {
    // Reuse is an improvement, not a precondition. If the embedder is down the
    // section still drafts — from the profile alone, and the caller can see
    // that nothing was reused.
    return [];
  }

  const { data, error } = await supabase.rpc("match_answers", {
    target_client: clientId,
    q_embedding: JSON.stringify(embedding),
    max_results: 3,
    min_similarity: 0.55,
  });
  if (error) return [];

  return ((data ?? []) as ReusedAnswer[]).map((row) => ({
    ...row,
    similarity: Number(row.similarity),
  }));
}

const SYSTEM = `You draft one section of a grant application for a consultant who will edit it.

Absolute rules:
- Use only the facts you are given about the organization. Never invent a
  number, a date, a partner, a past project or an outcome. If the section needs
  a fact you do not have, write the sentence and mark the gap inline as
  [NEED: what is missing] — a consultant can fill a marked gap in seconds and
  cannot find an invented one at all.
- Answer the requirement you are given, in the funder's own terms. Do not
  produce a generic proposal section.
- If the funder stated how this is evaluated, write to that.
- Respect the word limit if one is given.
- Where previously approved answers are supplied, build on them and keep their
  facts intact. They were written and checked by the consultant.
- Plain prose. No headings, no bullet lists unless the requirement asks for
  them, no preamble like "Here is the section".`;

function buildPrompt(
  requirement: DraftRequirement,
  client: DraftClient,
  reused: ReusedAnswer[],
): string {
  const lines: string[] = [];

  lines.push(`Funder's requirement: ${requirement.label}`);
  if (requirement.detail) lines.push(`What it must cover: ${requirement.detail}`);
  if (requirement.evaluationNote) lines.push(`How it is evaluated: ${requirement.evaluationNote}`);
  if (requirement.wordLimit) lines.push(`Word limit: ${requirement.wordLimit}`);
  if (requirement.sourceQuote) lines.push(`The call says, verbatim: "${requirement.sourceQuote}"`);

  lines.push("", `Organization: ${client.name}`);
  if (client.stage) lines.push(`Legal form: ${client.stage}`);
  if (client.sectors?.length) lines.push(`Sectors: ${client.sectors.join(", ")}`);
  if (client.jurisdictions?.length) lines.push(`Operates in: ${client.jurisdictions.join(", ")}`);
  if (client.annualBudget) lines.push(`Annual budget: ${client.annualBudget.toLocaleString()}`);
  if (client.capabilities) lines.push(`Track record: ${client.capabilities}`);
  if (client.beneficiaries) lines.push(`Who benefits: ${client.beneficiaries}`);

  if (reused.length > 0) {
    lines.push("", "Previously approved answers from this client, to build on:");
    for (const answer of reused) {
      lines.push(`--- ${answer.label} ---`, answer.content);
    }
  }

  lines.push("", `Write the section now. Nothing else.`);
  return lines.join("\n");
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Strips the preamble and fencing models add despite being told not to. */
export function cleanDraft(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/^(?:here(?:'s| is)[^\n]*|sure[^\n]*|certainly[^\n]*)\n+/i, "")
    .trim();
}

export async function draftSection(
  supabase: SupabaseClient,
  clientId: string,
  requirement: DraftRequirement,
): Promise<DraftResult> {
  const { data: clientRow, error: clientError } = await supabase
    .from("clients")
    .select(
      "id, name, client_profiles(sectors, jurisdictions, stage, annual_budget, capabilities, beneficiaries)",
    )
    .eq("id", clientId)
    .maybeSingle();
  if (clientError) throw new Error(`could not read the client: ${clientError.message}`);
  if (!clientRow) throw new NoProfileError();

  const row = clientRow as unknown as {
    id: string;
    name: string;
    client_profiles: {
      sectors: string[] | null;
      jurisdictions: string[] | null;
      stage: string | null;
      annual_budget: number | null;
      capabilities: string | null;
      beneficiaries: string | null;
    } | null;
  };
  const profile = row.client_profiles;

  // Drafting without a profile produces confident text about an organization we
  // know nothing about, which is the single most damaging thing this product
  // could hand a consultant.
  if (!profile || (!profile.capabilities && !profile.sectors?.length)) throw new NoProfileError();

  const client: DraftClient = {
    id: row.id,
    name: row.name,
    sectors: profile.sectors,
    jurisdictions: profile.jurisdictions,
    stage: profile.stage,
    annualBudget: profile.annual_budget,
    capabilities: profile.capabilities,
    beneficiaries: profile.beneficiaries,
  };

  const reused = await findReusableAnswers(supabase, clientId, requirement);

  const response = await callLlm(
    {
      role: "write",
      temperature: 0.4,
      // Budget for thinking as well as writing. The hosted models are
      // reasoning models: gpt-oss-120b spends about 700 tokens working out what
      // to say before it emits a character, and at 1000 it returns
      // finish_reason "length" with *zero* visible content. Sizing the budget
      // purely from the requested word count produced a guaranteed empty 200
      // for any section under ~350 words — which the chain then treated as a
      // provider failure and answered from the local floor instead. Drafts were
      // arriving from the small local model for that reason alone.
      maxTokens: Math.min(6000, REASONING_HEADROOM + (requirement.wordLimit ?? 600) * 3),
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildPrompt(requirement, client, reused) },
      ],
      validate: (candidate) => cleanDraft(candidate).length > 80,
    },
    { timeoutMs: 120_000 },
  );

  const content = cleanDraft(response.text);

  if (reused.length > 0) {
    // Counted, not just timestamped. Which answers a client's proposals keep
    // reaching for is the only evidence of what the library is worth, and it
    // needs an increment — which PostgREST cannot express, hence the function.
    await supabase.rpc("record_answer_use", { answer_ids: reused.map((a) => a.id) });
  }

  return {
    content,
    wordCount: countWords(content),
    reusedAnswers: reused,
    draftedBy: `${response.provider}/${response.model}`,
    attempts: response.attempts,
  };
}

/**
 * Store an answer for reuse, embedded so later requirements can find it by
 * meaning. Called when a consultant saves a section they are happy with.
 */
export async function saveAnswer(
  supabase: SupabaseClient,
  clientId: string,
  label: string,
  content: string,
): Promise<{ id: string }> {
  let embedding: number[] | null = null;
  try {
    embedding = await embedOne(`${label}. ${content}`.slice(0, 4000), ANSWER_EMBED_MODEL);
  } catch {
    // Storing it unembedded is still worth doing — it is visible in the library
    // and can be embedded on a later pass. Refusing to save it because a local
    // model is down would lose the consultant's actual work.
    embedding = null;
  }

  const { data, error } = await supabase
    .from("answer_library")
    .insert({
      client_id: clientId,
      label: label.slice(0, 200),
      content,
      embedding: embedding ? JSON.stringify(embedding) : null,
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not save the answer: ${error.message}`);
  return data as { id: string };
}
