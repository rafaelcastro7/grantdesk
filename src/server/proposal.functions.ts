import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ACCESS_TOKEN_MESSAGE, callerClient } from "./caller";
import { readRequirementsForGrant } from "./read-requirements";
import { assessCondition } from "./assess-condition";
import { draftSection, NoProfileError, saveAnswer, type DraftRequirement } from "./draft";

const auth = z.string().min(10, ACCESS_TOKEN_MESSAGE);

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

      const result = await draftSection(supabase, data.clientId, target);

      // Captured before the overwrite below, so a re-draft that turns out
      // worse than the last one is a click to go back to, not a rewrite from
      // scratch.
      const { data: previous } = await supabase
        .from("proposal_sections")
        .select("content, word_count, drafted_by")
        .eq("proposal_id", data.proposalId)
        .eq("requirement_id", data.requirementId)
        .maybeSingle();
      if (previous?.content?.trim()) {
        await supabase.from("proposal_section_revisions").insert({
          proposal_id: data.proposalId,
          requirement_id: data.requirementId,
          content: previous.content,
          word_count: previous.word_count,
          drafted_by: previous.drafted_by,
        });
      }

      const { error: writeError } = await supabase.from("proposal_sections").upsert(
        {
          proposal_id: data.proposalId,
          requirement_id: data.requirementId,
          heading: target.label,
          content: result.content,
          reused_answer_ids: result.reusedAnswers.map((a) => a.id),
          drafted_by: result.draftedBy,
          word_count: result.wordCount,
          fabrication_concerns: result.fabrications,
          sort_order: 0,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "proposal_id, requirement_id" },
      );
      if (writeError) throw new Error(writeError.message);

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
