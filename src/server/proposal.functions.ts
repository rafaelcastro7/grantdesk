import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ACCESS_TOKEN_MESSAGE, callerClient } from "./caller";
import { extractRequirementsFromText, extractRequirementsFromUrl } from "./extract-requirements";
import { draftSection, NoProfileError, saveAnswer, type DraftRequirement } from "./draft";

const auth = z.string().min(10, ACCESS_TOKEN_MESSAGE);

/**
 * Read a call's own requirements and store them against the grant.
 *
 * Idempotent by heading: re-reading an updated call revises what it asks for
 * rather than producing a second copy of every section.
 */
export const readRequirements = createServerFn({ method: "POST" })
  .validator(z.object({ grantId: z.string().uuid(), accessToken: auth }))
  .handler(async ({ data }) => {
    const supabase = callerClient(data.accessToken);
    try {
      const { data: grant, error } = await supabase
        .from("grants")
        .select("id, url, title, summary, eligibility_note")
        .eq("id", data.grantId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!grant) throw new Error("That call is no longer in the catalog.");

      const row = grant as {
        url: string;
        title: string;
        summary: string | null;
        eligibility_note: string | null;
      };

      // Prefer the text ingestion already captured. Many funders publish their
      // detail page as a JavaScript shell — fetching a Grants.gov opportunity
      // URL returns a page containing none of its own requirements — while the
      // same call's full description came down through the API and is sitting
      // in our own table. Re-fetching to read text we already hold would be
      // slower, more fragile and worse.
      const held = [row.summary, row.eligibility_note].filter(Boolean).join("\n\n");
      const { requirements, provenance } =
        held.trim().length >= 400
          ? await extractRequirementsFromText(held, row.url, row.title)
          : await extractRequirementsFromUrl(row.url);

      if (requirements.length === 0) {
        return {
          ok: false as const,
          error: `We could not find any stated requirements for this call. It may be published only as a PDF — open ${row.url} and add the sections yourself.`,
        };
      }

      // Replace what a previous read extracted, rather than merging into it.
      //
      // The upsert keys on the exact label and a model does not produce the
      // same wording twice: re-reading one call turned six conditions into
      // nineteen — "Applicant Status", "Nonprofit Status" and "Applicant
      // 501(c)(3) Status" all describing one rule. A consultant reading that
      // list cannot tell which are real.
      //
      // Only rows this app extracted, and only those nothing has been written
      // against, are cleared: headings the consultant typed from the funder's
      // form survive, and so does any requirement with a drafted section
      // attached to it.
      const { data: drafted } = await supabase
        .from("proposal_sections")
        .select("requirement_id")
        .not("requirement_id", "is", null);
      const keep = new Set(
        ((drafted ?? []) as Array<{ requirement_id: string }>).map((r) => r.requirement_id),
      );

      const { data: previous } = await supabase
        .from("requirements")
        .select("id")
        .eq("grant_id", data.grantId)
        .not("extracted_from", "is", null);

      const stale = ((previous ?? []) as Array<{ id: string }>)
        .map((r) => r.id)
        .filter((id) => !keep.has(id));
      if (stale.length > 0) {
        await supabase.from("requirements").delete().in("id", stale);
      }

      const { error: writeError } = await supabase.from("requirements").upsert(
        requirements.map((r) => ({
          grant_id: data.grantId,
          label: r.label,
          detail: r.detail,
          kind: r.kind,
          word_limit: r.wordLimit,
          evaluation_note: r.evaluationNote,
          source_quote: r.sourceQuote,
          is_critical: r.isCritical,
          sort_order: r.sortOrder,
          extracted_at: provenance.extractedAt,
          extracted_from: provenance.source,
        })),
        { onConflict: "grant_id, label" },
      );
      if (writeError) throw new Error(writeError.message);

      return { ok: true as const, count: requirements.length, provenance };
    } catch (error) {
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
        .select("id, label, detail, word_limit, evaluation_note, source_quote")
        .eq("id", data.requirementId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!requirement) throw new Error("That requirement is no longer on the call.");

      const row = requirement as {
        id: string;
        label: string;
        detail: string | null;
        word_limit: number | null;
        evaluation_note: string | null;
        source_quote: string | null;
      };
      const target: DraftRequirement = {
        id: row.id,
        label: row.label,
        detail: row.detail,
        wordLimit: row.word_limit,
        evaluationNote: row.evaluation_note,
        sourceQuote: row.source_quote,
      };

      const result = await draftSection(supabase, data.clientId, target);

      const { error: writeError } = await supabase.from("proposal_sections").upsert(
        {
          proposal_id: data.proposalId,
          requirement_id: data.requirementId,
          heading: target.label,
          content: result.content,
          reused_answer_ids: result.reusedAnswers.map((a) => a.id),
          drafted_by: result.draftedBy,
          word_count: result.wordCount,
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
