import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ACCESS_TOKEN_MESSAGE, callerClient } from "./caller";
import { readRequirementsForGrant } from "./read-requirements";
import { assessCondition } from "./assess-condition";
import { draftSection, NoProfileError, saveAnswer, type DraftRequirement } from "./draft";
import { draftingGate, fromRow, type DecisionRow } from "@/lib/go-decision";
import type { SupabaseClient } from "@supabase/supabase-js";

const auth = z.string().min(10, ACCESS_TOKEN_MESSAGE);

class MismatchError extends Error {}

/**
 * The three ids a request carries must describe one application: the
 * proposal belongs to the client, and the requirement is on that proposal's
 * call and is either shared or this client's own. RLS alone cannot say that —
 * a consultant owns all their clients, so it happily lets a request mix
 * client A's profile, client B's proposal and a third grant's requirement,
 * which also sidestepped the go / no-go lock by naming a client without one.
 */
async function assertOneApplication(
  supabase: SupabaseClient,
  ids: { clientId: string; proposalId: string; requirementId: string },
): Promise<{ grantId: string }> {
  const [{ data: proposal, error: proposalError }, { data: requirement, error: reqError }] =
    await Promise.all([
      supabase
        .from("proposals")
        .select("client_id, grant_id")
        .eq("id", ids.proposalId)
        .maybeSingle(),
      supabase
        .from("requirements")
        .select("grant_id, client_id")
        .eq("id", ids.requirementId)
        .maybeSingle(),
    ]);
  if (proposalError) throw new Error(proposalError.message);
  if (reqError) throw new Error(reqError.message);
  const p = proposal as { client_id: string; grant_id: string } | null;
  const r = requirement as { grant_id: string; client_id: string | null } | null;
  if (!p || p.client_id !== ids.clientId) {
    throw new MismatchError("That application does not belong to this client.");
  }
  if (!r || r.grant_id !== p.grant_id || (r.client_id !== null && r.client_id !== p.client_id)) {
    throw new MismatchError("That requirement is not part of this application.");
  }
  return { grantId: p.grant_id };
}

export const readRequirements = createServerFn({ method: "POST" })
  .validator(z.object({ grantId: z.string().uuid(), accessToken: auth }))
  .handler(async ({ data }) => {
    try {
      const result = await readRequirementsForGrant(callerClient(data.accessToken), data.grantId);
      return { ok: true as const, ...result };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });

/**
 * Read one condition against the client's profile, once per proposal — the
 * result is cached in requirement_assessments rather than recomputed on
 * every visit, since the client's profile and the condition's wording do not
 * change between page loads and a model call on every render would be pure
 * waste charged against the same token budget drafting shares.
 */
export const assessRequirement = createServerFn({ method: "POST" })
  .validator(
    z.object({
      clientId: z.string().uuid(),
      proposalId: z.string().uuid(),
      requirementId: z.string().uuid(),
      accessToken: auth,
    }),
  )
  .handler(async ({ data }) => {
    const supabase = callerClient(data.accessToken);
    try {
      await assertOneApplication(supabase, data);
      const { data: cached, error: cacheError } = await supabase
        .from("requirement_assessments")
        .select("assessment")
        .eq("proposal_id", data.proposalId)
        .eq("requirement_id", data.requirementId)
        .maybeSingle();
      if (cacheError) throw new Error(cacheError.message);
      if (cached)
        return { ok: true as const, assessment: (cached as { assessment: string }).assessment };

      const { data: req, error: reqError } = await supabase
        .from("requirements")
        .select("label, detail, source_quote")
        .eq("id", data.requirementId)
        .maybeSingle();
      if (reqError) throw new Error(reqError.message);
      if (!req) throw new Error("That requirement no longer exists.");

      const row = req as { label: string; detail: string | null; source_quote: string | null };
      const result = await assessCondition(supabase, data.clientId, {
        label: row.label,
        detail: row.detail,
        sourceQuote: row.source_quote,
      });

      const { error: writeError } = await supabase.from("requirement_assessments").upsert(
        {
          proposal_id: data.proposalId,
          requirement_id: data.requirementId,
          assessment: result.assessment,
          model: result.model,
        },
        { onConflict: "proposal_id, requirement_id" },
      );
      if (writeError) throw new Error(writeError.message);

      return { ok: true as const, assessment: result.assessment };
    } catch (error) {
      if (error instanceof NoProfileError) {
        return { ok: false as const, error: "Add more to this client's profile first." };
      }
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });

export const draftProposalSection = createServerFn({ method: "POST" })
  .validator(
    z.object({
      clientId: z.string().uuid(),
      proposalId: z.string().uuid(),
      requirementId: z.string().uuid(),
      accessToken: auth,
    }),
  )
  .handler(async ({ data }) => {
    const supabase = callerClient(data.accessToken);
    try {
      await assertOneApplication(supabase, data);
      const { data: requirement, error } = await supabase
        .from("requirements")
        .select(
          "id, label, detail, word_limit, evaluation_note, source_quote, grant_id, " +
            "grants(title, amount_min, amount_max, currency, deadline, funders(name))",
        )
        .eq("id", data.requirementId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!requirement) throw new Error("That requirement is no longer on the call.");

      const row = requirement as unknown as {
        id: string;
        label: string;
        detail: string | null;
        word_limit: number | null;
        evaluation_note: string | null;
        source_quote: string | null;
        grant_id: string;
        grants: {
          title: string;
          amount_min: number | null;
          amount_max: number | null;
          currency: string | null;
          deadline: string | null;
          funders: { name: string } | null;
        } | null;
      };
      const target: DraftRequirement = {
        id: row.id,
        label: row.label,
        detail: row.detail,
        wordLimit: row.word_limit,
        evaluationNote: row.evaluation_note,
        sourceQuote: row.source_quote,
        // Without this a budget section invented both the amount being
        // requested and a project name to attach it to.
        grant: row.grants
          ? {
              title: row.grants.title,
              funder: row.grants.funders?.name ?? null,
              amountMin: row.grants.amount_min,
              amountMax: row.grants.amount_max,
              currency: row.grants.currency,
              deadline: row.grants.deadline,
            }
          : null,
      };

      // Enforced here, not only by a disabled button: the SOP's rule is that no
      // writing starts before leadership records a go on the brief.
      const [{ data: policy, error: policyError }, { data: decisionRow, error: decisionError }] =
        await Promise.all([
          supabase
            .from("client_profiles")
            .select("requires_go_decision")
            .eq("client_id", data.clientId)
            .maybeSingle(),
          supabase
            .from("opportunity_decisions")
            .select("decision, decided_by, condition, condition_met")
            .eq("client_id", data.clientId)
            .eq("grant_id", row.grant_id)
            .maybeSingle(),
        ]);
      if (policyError) throw new Error(policyError.message);
      if (decisionError) throw new Error(decisionError.message);
      const gate = draftingGate(
        fromRow(decisionRow as DecisionRow | null),
        !!(policy as { requires_go_decision?: boolean } | null)?.requires_go_decision,
      );
      if (!gate.allowed) return { ok: false as const, error: gate.reason };

      // The record must match what the funder received.
      const { data: sent, error: sentError } = await supabase
        .from("submissions")
        .select("id")
        .eq("proposal_id", data.proposalId)
        .limit(1);
      if (sentError) throw new Error(sentError.message);
      if ((sent ?? []).length > 0) {
        return { ok: false as const, error: "This application was submitted and is locked." };
      }

      // The version this draft replaces, read before the (slow) model call:
      // if anyone saves the section while the model is writing, the save
      // below is refused instead of silently overwriting their work.
      const { data: before, error: beforeError } = await supabase
        .from("proposal_sections")
        .select("updated_at")
        .eq("proposal_id", data.proposalId)
        .eq("requirement_id", data.requirementId)
        .maybeSingle();
      if (beforeError) throw new Error(beforeError.message);

      const result = await draftSection(supabase, data.clientId, target);

      // Saved through save_section: the database keeps the current text as a
      // revision under a row lock, and the submitted-lock trigger refuses if
      // the application was sent while the model was writing.
      const { error: writeError } = await supabase.rpc("save_section", {
        target_proposal: data.proposalId,
        target_requirement: data.requirementId,
        new_heading: target.label,
        new_content: result.content,
        new_word_count: result.wordCount,
        new_drafted_by: result.draftedBy,
        new_fabrication_concerns: result.fabrications,
        new_reused_answer_ids: result.reusedAnswers.map((a) => a.id),
        expected_updated_at: (before as { updated_at: string } | null)?.updated_at ?? null,
      });
      if (writeError) {
        throw new Error(
          /changed by someone else/.test(writeError.message)
            ? "Someone saved this section while the draft was being written, so the draft was not saved over their work. Reload and draft again."
            : writeError.message,
        );
      }

      return {
        ok: true as const,
        wordCount: result.wordCount,
        reused: result.reusedAnswers.map((a) => ({
          label: a.label,
          similarity: Number(a.similarity.toFixed(2)),
        })),
        draftedBy: result.draftedBy,
        fabrications: result.fabrications,
      };
    } catch (caught) {
      if (caught instanceof NoProfileError) {
        return {
          ok: false as const,
          error:
            "This client's profile is too thin to draft from. Fill in what they do and what they have delivered, then try again — otherwise the draft would be invented.",
        };
      }
      return {
        ok: false as const,
        error: caught instanceof Error ? caught.message : String(caught),
      };
    }
  });

/** Keep a section the consultant approved, so the next call reuses it. */
export const saveToAnswerLibrary = createServerFn({ method: "POST" })
  .validator(
    z.object({
      clientId: z.string().uuid(),
      label: z.string().min(2),
      content: z.string().min(40, "Too short to be worth reusing."),
      accessToken: auth,
    }),
  )
  .handler(async ({ data }) => {
    try {
      const saved = await saveAnswer(
        callerClient(data.accessToken),
        data.clientId,
        data.label,
        data.content,
      );
      return { ok: true as const, id: saved.id };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
