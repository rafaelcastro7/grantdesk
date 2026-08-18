import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { serverEnv } from "@/lib/env.server";
import { assessSubmission, type Blocker, type SubmitCandidate } from "@/lib/submit-gate";
import { loadPastAwards } from "./past-awards";

/**
 * Submitting is the one action in this product that is irreversible from the
 * consultant's side, so it is the one that runs the most checks — and the last
 * one is always a person.
 *
 * The gate is re-evaluated on the server at the moment of submission rather
 * than trusting what the browser last computed. Between opening the page and
 * clicking submit, a deadline can pass and a profile edit can change the
 * verdict; a stale client-side assessment would record a submission the rules
 * no longer support.
 */
function callerClient(accessToken: string): SupabaseClient {
  const env = serverEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const auth = z.string().min(10, "Your session expired. Sign in again.");

async function buildCandidate(
  supabase: SupabaseClient,
  proposalId: string,
  humanReviewed: boolean,
): Promise<{ candidate: SubmitCandidate; clientId: string; grantId: string }> {
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

  const [{ data: requirements }, { data: sections }, { data: match }, { data: acks }, { count }] =
    await Promise.all([
      supabase
        .from("requirements")
        .select("id, label, kind, word_limit, is_critical")
        .eq("grant_id", row.grant_id),
      supabase
        .from("proposal_sections")
        .select("requirement_id, content, word_count")
        .eq("proposal_id", proposalId),
      supabase
        .from("matches")
        .select("verdict")
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
    ]);

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
      }>
    ).map((s) => [s.requirement_id ?? "", s]),
  );
  const acknowledged = new Set(
    ((acks ?? []) as Array<{ requirement_id: string }>).map((a) => a.requirement_id),
  );

  return {
    clientId: row.client_id,
    grantId: row.grant_id,
    candidate: {
      verdict: (match as { verdict: SubmitCandidate["verdict"] } | null)?.verdict ?? null,
      deadline: row.grants?.deadline ?? null,
      sections: reqs
        .filter((r) => r.kind === "section")
        .map((r) => ({
          label: r.label,
          content: written.get(r.id)?.content ?? null,
          wordLimit: r.word_limit,
          wordCount: written.get(r.id)?.word_count ?? null,
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
      const { candidate } = await buildCandidate(
        callerClient(data.accessToken),
        data.proposalId,
        // Readiness is reported as if review had not happened, so the checklist
        // always shows the confirmation as the remaining step rather than
        // hiding it. The consultant confirms at the moment of submitting.
        false,
      );
      const assessed = assessSubmission(candidate);
      return {
        ok: true as const,
        blockers: assessed.blockers,
        // Recomputed without the review line, which is what the submit button
        // itself asks for.
        readyForReview: assessed.blockers.every((b) => b.key === "not_reviewed"),
      };
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
      const { candidate } = await buildCandidate(supabase, data.proposalId, true);
      const assessed = assessSubmission(candidate);

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
      if (error) throw new Error(error.message);

      await supabase
        .from("proposals")
        .update({ status: "submitted", updated_at: new Date().toISOString() })
        .eq("id", data.proposalId);

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
