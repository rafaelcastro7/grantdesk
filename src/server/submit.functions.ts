import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ACCESS_TOKEN_MESSAGE, callerClient } from "./caller";
import { assessSubmission, type Blocker, type SubmitCandidate } from "@/lib/submit-gate";
import { loadPastAwards } from "./past-awards";
import { draftingGate, fromRow, type DecisionRow, type DraftingGate } from "@/lib/go-decision";

/** A client whose policy requires a go cannot send without one either. */
function withGoBlocker(blockers: Blocker[], gate: DraftingGate): Blocker[] {
  return gate.allowed
    ? blockers
    : [{ key: "go_decision", detail: gate.reason, isHard: true }, ...blockers];
}

const auth = z.string().min(10, ACCESS_TOKEN_MESSAGE);

async function buildCandidate(
  supabase: SupabaseClient,
  proposalId: string,
  humanReviewed: boolean,
): Promise<{
  candidate: SubmitCandidate;
  clientId: string;
  grantId: string;
  goGate: DraftingGate;
}> {
  const { data: proposal, error } = await supabase
    .from("proposals")
    .select("id, client_id, grant_id, grants(deadline)")
    .eq("id", proposalId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!proposal) throw new Error("That application no longer exists.");

  const row = proposal as unknown as {
    id: string;
    client_id: string;
    grant_id: string;
    grants: { deadline: string | null } | null;
  };

  const results = await Promise.all([
    // Shared requirements plus this client's own headings — never another
    // client's, which the caller may also own and RLS would therefore return.
    supabase
      .from("requirements")
      .select("id, label, kind, word_limit, is_critical")
      .eq("grant_id", row.grant_id)
      .or(`client_id.is.null,client_id.eq.${row.client_id}`),
    supabase
      .from("proposal_sections")
      .select("requirement_id, content, word_count, drafted_by")
      .eq("proposal_id", proposalId),
    supabase
      .from("matches")
      .select("verdict, matched_at")
      .eq("client_id", row.client_id)
      .eq("grant_id", row.grant_id)
      .maybeSingle(),
    supabase
      .from("requirement_acknowledgements")
      .select("requirement_id")
      .eq("proposal_id", proposalId),
    supabase
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("proposal_id", proposalId),
    supabase
      .from("client_profiles")
      .select("updated_at, requires_go_decision")
      .eq("client_id", row.client_id)
      .maybeSingle(),
    supabase
      .from("opportunity_decisions")
      .select("decision, decided_by, condition, condition_met")
      .eq("client_id", row.client_id)
      .eq("grant_id", row.grant_id)
      .maybeSingle(),
  ]);
  // A failed read must stop the gate, not empty it: an empty requirement or
  // acknowledgement list reads as "nothing outstanding" and lets a submission
  // through that the funder would reject.
  const failed = results.find((r) => r.error);
  if (failed?.error) throw new Error(`readiness could not be checked: ${failed.error.message}`);
  const [
    { data: requirements },
    { data: sections },
    { data: match },
    { data: acks },
    { count },
    { data: profile },
    { data: decision },
  ] = results;
  const goGate = draftingGate(
    fromRow(decision as DecisionRow | null),
    !!(profile as { requires_go_decision?: boolean } | null)?.requires_go_decision,
  );

  const reqs = (requirements ?? []) as Array<{
    id: string;
    label: string;
    kind: string;
    word_limit: number | null;
    is_critical: boolean;
  }>;
  const written = new Map(
    (
      (sections ?? []) as Array<{
        requirement_id: string | null;
        content: string | null;
        word_count: number | null;
        drafted_by: string | null;
      }>
    ).map((s) => [s.requirement_id ?? "", s]),
  );
  const acknowledged = new Set(
    ((acks ?? []) as Array<{ requirement_id: string }>).map((a) => a.requirement_id),
  );

  return {
    clientId: row.client_id,
    grantId: row.grant_id,
    goGate,
    candidate: {
      verdict: (match as { verdict: SubmitCandidate["verdict"] } | null)?.verdict ?? null,
      verdictAt: (match as { matched_at: string } | null)?.matched_at ?? null,
      profileUpdatedAt: (profile as { updated_at: string } | null)?.updated_at ?? null,
      deadline: row.grants?.deadline ?? null,
      sections: reqs
        .filter((r) => r.kind === "section")
        .map((r) => ({
          label: r.label,
          content: written.get(r.id)?.content ?? null,
          wordLimit: r.word_limit,
          wordCount: written.get(r.id)?.word_count ?? null,
          draftedBy: written.get(r.id)?.drafted_by ?? null,
        })),
      conditions: reqs
        .filter((r) => r.kind !== "section")
        .map((r) => ({
          label: r.label,
          isCritical: r.is_critical,
          acknowledged: acknowledged.has(r.id),
        })),
      humanReviewed,
      alreadySubmitted: (count ?? 0) > 0,
      today: new Date(),
    },
  };
}

/** What is standing between this application and being sent. */
export const checkReadiness = createServerFn({ method: "POST" })
  .validator(z.object({ proposalId: z.string().uuid(), accessToken: auth }))
  .handler(async ({ data }) => {
    try {
      const { candidate, goGate } = await buildCandidate(
        callerClient(data.accessToken),
        data.proposalId,
        // Readiness is reported as if review had not happened, so the checklist
        // always shows the confirmation as the remaining step rather than
        // hiding it. The consultant confirms at the moment of submitting.
        false,
      );
      const assessed = assessSubmission(candidate);
      return { ok: true as const, blockers: withGoBlocker(assessed.blockers, goGate) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });

export const submitProposal = createServerFn({ method: "POST" })
  .validator(
    z.object({
      proposalId: z.string().uuid(),
      method: z.string().max(120).optional(),
      confirmationNumber: z.string().max(120).optional(),
      notes: z.string().max(2000).optional(),
      /** Set only when the consultant has been shown the soft blockers and proceeds anyway. */
      overrideSoftBlockers: z.boolean().default(false),
      accessToken: auth,
    }),
  )
  .handler(async ({ data }) => {
    const supabase = callerClient(data.accessToken);
    try {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error("Your session expired. Sign in again.");

      // Reassessed here, on the server, with humanReviewed true — the click is
      // the confirmation. Trusting the browser's last assessment would let a
      // deadline pass between page load and submit.
      const { candidate, goGate } = await buildCandidate(supabase, data.proposalId, true);
      const assessed = assessSubmission(candidate);
      assessed.blockers = withGoBlocker(assessed.blockers, goGate);

      const hard = assessed.blockers.filter((b) => b.isHard);
      if (hard.length > 0) {
        return { ok: false as const, blockers: hard, error: hard[0]!.detail };
      }
      if (assessed.blockers.length > 0 && !data.overrideSoftBlockers) {
        return {
          ok: false as const,
          blockers: assessed.blockers,
          error: "Some checks did not pass. Review them, then submit anyway if you disagree.",
        };
      }

      const { error } = await supabase.from("submissions").insert({
        proposal_id: data.proposalId,
        method: data.method ?? null,
        confirmation_number: data.confirmationNumber ?? null,
        notes: data.notes ?? null,
        human_reviewed_by: user.user.id,
        outcome: "awaiting",
        // Recorded because a submission made over a stated warning is a
        // decision someone made, and "did we know?" has to stay answerable.
        overridden_blockers: assessed.blockers as unknown as Blocker[],
      });
      // A second click that lost the race: the submission exists, which is
      // what the consultant wanted — say so instead of a constraint message.
      if (error?.code === "23505") return { ok: true as const, overrode: 0 };
      if (error) throw new Error(error.message);

      const { error: touchError } = await supabase
        .from("proposals")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", data.proposalId);
      if (touchError)
        console.warn(`submission recorded; proposal timestamp not updated: ${touchError.message}`);

      return { ok: true as const, overrode: assessed.blockers.length };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });

/** Who has won this program before — the first question a consultant asks. */
export const getPastAwards = createServerFn({ method: "POST" })
  .validator(z.object({ grantId: z.string().uuid(), accessToken: auth }))
  .handler(async ({ data }) => {
    try {
      return {
        ok: true as const,
        result: await loadPastAwards(callerClient(data.accessToken), data.grantId),
      };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
