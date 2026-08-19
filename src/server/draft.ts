import type { SupabaseClient } from "@supabase/supabase-js";
import { callLlm } from "./llm";
import { ANSWER_EMBED_MODEL, embedOne } from "./embed";
import { listPlaces } from "@/lib/applicant-types";

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
  /**
   * The call this section belongs to.
   *
   * Absent at first, and a budget section invented "$120,000 we are
   * requesting" and a project name to go with it — not out of carelessness,
   * but because the requirement asked about the request and nothing had said
   * what the request was. Facts the model does not have are the ones it fills
   * in, so the fix is to give it the ones we hold.
   */
  grant?: {
    title: string;
    funder: string | null;
    amountMin: number | null;
    amountMax: number | null;
    currency: string | null;
    deadline: string | null;
  } | null;
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
 * Measured against gpt-oss-120b on a real section prompt. At default reasoning
 * effort it burns ~700 tokens before emitting anything and needs a 1500-token
 * ceiling; with `reasoning_effort: "low"` — which llm.ts now sends where it is
 * understood — the same output costs 337. The headroom is sized for the
 * latter, with room to spare, because an over-budget request costs nothing
 * when the model stops on its own while an under-budget one costs the whole
 * call.
 *
 * It is not free, though: Groq bills the *requested* max_tokens against an
 * 8000/minute ceiling, so headroom nobody uses is drafts nobody gets.
 */
const REASONING_HEADROOM = 500;

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

export const DRAFT_SYSTEM_PROMPT = `You draft one section of a grant application for a consultant who will edit it.

Absolute rules:
- Use only the facts you are given about the organization. Never invent a
  number, a date, a partner, a past project or an outcome. If the section needs
  a fact you do not have, write the sentence and mark the gap inline as
  [NEED: what is missing] — a consultant can fill a marked gap in seconds and
  cannot find an invented one at all.
- Never round or soften a figure you were given. "312 volunteers" is not "about
  300 volunteers", and "since 2011" is not "for over a decade". A rounded figure
  reads as careful and is a different claim from the one the consultant
  approved — and it is the version a funder will check.
- That includes proportions. "Roughly 45% from municipal grants, 30% from
  foundations" is an invented funding mix even though it sounds like context
  rather than a claim, and a funder can check it. Percentages, splits and
  ratios are facts; mark them [NEED: ...] like any other.
- The amount being requested is a fact too. You may be told the call's award
  range; you are never told what this applicant decided to ask for. Write
  [NEED: amount we are requesting] rather than choosing a number inside the
  range, and never name a project the applicant has not named. A number outside
  the stated range is worse still — it tells the funder nobody read the call.
- Answer the requirement you are given, in the funder's own terms. Do not
  produce a generic proposal section.
- If the funder stated how this is evaluated, write to that.
- The word limit is the funder's, not a suggestion. Aim about ten percent under
  it and stop; a section that runs over is truncated or rejected by the form
  itself, and trimming it is work the consultant then has to redo.
- Where previously approved answers are supplied, build on them and keep their
  facts intact. They were written and checked by the consultant.
- But use only the ones that actually answer THIS requirement. They are
  retrieved by similarity and similarity is not judgement: an answer about past
  projects is not an answer about who will staff this one. Ignoring a supplied
  answer entirely is the right call when it does not fit, and padding a section
  with material from a different question is worse than a shorter section.
- Plain prose. No headings, no bullet lists unless the requirement asks for
  them, no preamble like "Here is the section".`;

function buildPrompt(
  requirement: DraftRequirement,
  client: DraftClient,
  reused: ReusedAnswer[],
): string {
  const lines: string[] = [];

  if (requirement.grant) {
    const g = requirement.grant;
    lines.push(`The call: ${g.title}${g.funder ? `, from ${g.funder}` : ""}`);
    const unit = g.currency ?? "";
    if (g.amountMin && g.amountMax) {
      lines.push(
        `Awards range from ${unit} ${g.amountMin.toLocaleString()} to ${unit} ${g.amountMax.toLocaleString()}.`,
      );
    } else if (g.amountMax) {
      lines.push(`Awards are up to ${unit} ${g.amountMax.toLocaleString()}.`);
    } else if (g.amountMin) {
      lines.push(`Awards start at ${unit} ${g.amountMin.toLocaleString()}.`);
    }
    if (g.deadline) lines.push(`It closes on ${g.deadline}.`);
    lines.push("");
  }

  lines.push(`Funder's requirement: ${requirement.label}`);
  if (requirement.detail) lines.push(`What it must cover: ${requirement.detail}`);
  if (requirement.evaluationNote) lines.push(`How it is evaluated: ${requirement.evaluationNote}`);
  if (requirement.wordLimit)
    lines.push(
      `Hard word limit: ${requirement.wordLimit}. Aim for about ${Math.round(requirement.wordLimit * 0.9)}.`,
    );
  if (requirement.sourceQuote) lines.push(`The call says, verbatim: "${requirement.sourceQuote}"`);

  lines.push("", `Organization: ${client.name}`);
  if (client.stage) lines.push(`Legal form: ${client.stage}`);
  if (client.sectors?.length) lines.push(`Sectors: ${client.sectors.join(", ")}`);
  if (client.jurisdictions?.length) lines.push(`Operates in: ${listPlaces(client.jurisdictions)}`);
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
        { role: "system", content: DRAFT_SYSTEM_PROMPT },
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
