/**
 * Is this application actually ready to send?
 *
 * The gate is deliberately not a score. A consultant about to put their name on
 * a client's application needs to know exactly what is unfinished, not a number
 * that says "78% ready" — so this returns a list of specific, fixable blockers,
 * each phrased as the thing to go and do.
 *
 * Nothing here is a model's opinion. Every check is decidable from what is in
 * the database, which means the answer is the same on Friday afternoon as it
 * was on Monday, and a consultant who overrides it is overriding a stated fact
 * rather than a guess.
 */

export type Blocker = {
  key: string;
  /** What to do, in the consultant's words. */
  detail: string;
  /**
   * A hard blocker cannot be overridden: the application would be rejected or
   * the claim would be untrue. A soft one is a judgement the consultant is
   * entitled to make against our advice.
   */
  isHard: boolean;
};

export type SubmitCandidate = {
  verdict: "eligible" | "ineligible" | "needs_input" | null;
  /**
   * When matching last produced that verdict, and when the client's profile
   * last changed — both null-able independently, since a profile can exist
   * with no match ever run and a match can predate this column existing.
   * Compared to catch a verdict left over from before a profile edit: a
   * consultant who corrects `jurisdictions` after drafting has no reason to
   * remember that matching does not re-run itself, and "eligible" sitting
   * next to a submit button reads as current whether or not it still is.
   */
  verdictAt: string | null;
  profileUpdatedAt: string | null;
  deadline: string | null;
  /** Requirements the funder stated, split by what we can and cannot draft. */
  sections: Array<{
    label: string;
    content: string | null;
    wordLimit: number | null;
    wordCount: number | null;
    /** `provider/model`, or null once a person has edited it. */
    draftedBy?: string | null;
  }>;
  conditions: Array<{ label: string; isCritical: boolean; acknowledged: boolean }>;
  /** Set only when a person has actually confirmed they read it. */
  humanReviewed: boolean;
  alreadySubmitted: boolean;
  today: Date;
};

const GAP_MARKER = /\[NEED:[^\]]*\]/g;

export function countGaps(content: string | null): number {
  if (!content) return 0;
  return (content.match(GAP_MARKER) ?? []).length;
}

export function assessSubmission(candidate: SubmitCandidate): {
  blockers: Blocker[];
  canSubmit: boolean;
  /** True when only overridable blockers remain, so the UI can offer that path. */
  canOverride: boolean;
} {
  const blockers: Blocker[] = [];

  if (candidate.alreadySubmitted) {
    blockers.push({
      key: "already_submitted",
      detail: "This application has already been recorded as submitted.",
      isHard: true,
    });
  }

  if (candidate.verdict === "ineligible") {
    blockers.push({
      key: "ineligible",
      detail:
        "The rules ruled this client out of this call. Submitting would waste the client's time and the funder's.",
      isHard: true,
    });
  } else if (candidate.verdict === "needs_input") {
    blockers.push({
      key: "unverified_eligibility",
      detail:
        "Eligibility has not been settled for this client. Run matching, or fill the profile field it is waiting on.",
      isHard: false,
    });
  } else if (candidate.verdict === null) {
    // Distinct from "needs_input": that means matching ran and found a gap in
    // the profile. This means matching never ran at all for this pairing —
    // reached by a direct link, not the catalog — so nobody has looked at
    // eligibility yet, not even partially.
    blockers.push({
      key: "never_matched",
      detail: "Eligibility was never checked for this client and call. Run matching first.",
      isHard: false,
    });
  } else if (
    // A settled verdict (eligible or ineligible, not the branches above) can
    // still be stale: the check ran, but the profile it ran against is not
    // the one that exists now. Ineligible already hard-blocks above and this
    // adds nothing there; eligible is the case where staying silent would
    // let a since-invalidated "yes" reach the submit button unchallenged.
    candidate.verdict === "eligible" &&
    candidate.verdictAt &&
    candidate.profileUpdatedAt &&
    new Date(candidate.profileUpdatedAt).getTime() > new Date(candidate.verdictAt).getTime()
  ) {
    blockers.push({
      key: "stale_eligibility",
      detail:
        "This client's profile changed after eligibility was last checked. Re-run matching to confirm it still applies.",
      isHard: false,
    });
  }

  if (candidate.deadline) {
    const closes = new Date(`${candidate.deadline}T23:59:59Z`);
    if (!Number.isNaN(closes.getTime()) && closes.getTime() < candidate.today.getTime()) {
      blockers.push({
        key: "closed",
        detail: `This call closed on ${candidate.deadline}.`,
        isHard: true,
      });
    }
  }

  const empty = candidate.sections.filter((s) => !s.content?.trim());
  if (empty.length > 0) {
    blockers.push({
      key: "empty_sections",
      detail:
        empty.length === 1
          ? `"${empty[0]!.label}" has not been written yet.`
          : `${empty.length} sections have not been written yet, starting with "${empty[0]!.label}".`,
      isHard: true,
    });
  }

  // An unresolved gap marker is a fact the draft admitted it did not have. It
  // would reach the funder as a literal "[NEED: …]" in the form, which is the
  // most visible possible way to look careless.
  const withGaps = candidate.sections.filter((s) => countGaps(s.content) > 0);
  if (withGaps.length > 0) {
    const total = withGaps.reduce((sum, s) => sum + countGaps(s.content), 0);
    blockers.push({
      key: "unfilled_gaps",
      detail: `${total} marked gap${total === 1 ? "" : "s"} still need${total === 1 ? "s" : ""} a real fact, in "${withGaps[0]!.label}".`,
      isHard: true,
    });
  }

  const over = candidate.sections.filter(
    (s) => s.wordLimit !== null && (s.wordCount ?? 0) > s.wordLimit,
  );
  if (over.length > 0) {
    const first = over[0]!;
    const overBy = `${(first.wordCount ?? 0) - first.wordLimit!} words over the funder's limit of ${first.wordLimit}`;
    blockers.push({
      key: "over_limit",
      // Named like empty_sections and unfilled_gaps below: a count, not just
      // the first offender, so fixing the one named here does not surface a
      // second one for the first time on the next check.
      detail:
        over.length === 1
          ? `"${first.label}" is ${overBy}.`
          : `${over.length} sections are over the funder's word limit, starting with "${first.label}" (${overBy}).`,
      // Some funders truncate, some reject. We cannot know which, so this is
      // stated rather than enforced.
      isHard: false,
    });
  }

  // The provider chain falls through to a small local model when the hosted
  // ones are unreachable, and for weeks nothing anywhere said so. A draft
  // written by the floor is not the same product as one written by the
  // intended model — it is likelier to invent a figure, which the eval
  // measured — and the consultant is entitled to know that before it reaches a
  // funder. Soft, because it is their judgement to make: they may have read
  // every word and be satisfied.
  const fallback = candidate.sections.filter((s) => s.draftedBy?.startsWith("ollama"));
  if (fallback.length > 0) {
    blockers.push({
      key: "fallback_model",
      detail: `${fallback.length === 1 ? `"${fallback[0]!.label}" was` : `${fallback.length} sections were`} written by the local fallback model, because the usual ones were unreachable. Read them closely, or draft again now that the chain is back.`,
      isHard: false,
    });
  }

  const unmet = candidate.conditions.filter((c) => c.isCritical && !c.acknowledged);
  if (unmet.length > 0) {
    blockers.push({
      key: "unmet_conditions",
      detail: `The call rejects applications without "${unmet[0]!.label}"${
        unmet.length > 1
          ? ` and ${unmet.length - 1} other requirement${unmet.length > 2 ? "s" : ""}`
          : ""
      }. Confirm you have it.`,
      isHard: true,
    });
  }

  // Last, and never automatic. Everything above this line is the machine's
  // work; this line is the point at which a person takes responsibility for it.
  if (!candidate.humanReviewed) {
    blockers.push({
      key: "not_reviewed",
      detail: "Nobody has confirmed they read this application end to end.",
      isHard: true,
    });
  }

  const hard = blockers.filter((b) => b.isHard);
  return {
    blockers,
    canSubmit: blockers.length === 0,
    canOverride: hard.length === 0 && blockers.length > 0,
  };
}
