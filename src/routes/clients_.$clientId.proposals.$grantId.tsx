import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { accessToken } from "@/lib/session";
import { errorMessage } from "@/lib/error-message";
import {
  draftProposalSection,
  readRequirements,
  saveToAnswerLibrary,
} from "@/server/proposal.functions";
import { checkReadiness, getPastAwards, submitProposal } from "@/server/submit.functions";
import type { Blocker } from "@/lib/submit-gate";
import type { PastAwardsResult } from "@/server/past-awards";

export const Route = createFileRoute("/clients_/$clientId/proposals/$grantId")({
  component: ProposalPage,
});

type Requirement = {
  id: string;
  label: string;
  detail: string | null;
  kind: "section" | "eligibility" | "attachment" | "criterion";
  word_limit: number | null;
  evaluation_note: string | null;
  source_quote: string | null;
  is_critical: boolean;
  sort_order: number;
};

type Section = {
  id: string;
  requirement_id: string | null;
  heading: string;
  content: string | null;
  word_count: number | null;
  drafted_by: string | null;
  reused_answer_ids: string[];
};

/**
 * One call, one client, one application.
 *
 * The screen is organized by the funder's requirements rather than by a
 * proposal template, because that is the actual difference between this and a
 * blank document: a consultant is answering *this* funder's questions, in their
 * order, against the criteria they published.
 *
 * It serves three of the five questions in docs/SPEC.md — what does this call
 * require, draft it reusing what I already wrote, and is it ready to send — so
 * it stays inside the page budget in ADR-0002 rather than needing an exception.
 */
function ProposalPage() {
  const { clientId, grantId } = Route.useParams();
  const runRead = useServerFn(readRequirements);
  const runDraft = useServerFn(draftProposalSection);
  const runSaveAnswer = useServerFn(saveToAnswerLibrary);
  const runReadiness = useServerFn(checkReadiness);
  const runSubmit = useServerFn(submitProposal);
  const runPastAwards = useServerFn(getPastAwards);

  const [grant, setGrant] = useState<{
    title: string;
    url: string;
    deadline: string | null;
  } | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<Requirement[] | null>(null);
  const [sections, setSections] = useState<Record<string, Section>>({});
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [submission, setSubmission] = useState<{
    submitted_at: string;
    outcome: string | null;
    confirmation_number: string | null;
  } | null>(null);
  const [blockers, setBlockers] = useState<Blocker[] | null>(null);
  const [awards, setAwards] = useState<PastAwardsResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const autoRead = useRef(false);

  const load = useCallback(async () => {
    const { data: grantRow } = await supabase()
      .from("grants")
      .select("title, url, deadline")
      .eq("id", grantId)
      .maybeSingle();
    setGrant(grantRow as typeof grant);

    // The proposal row is created on arrival rather than behind a button: the
    // consultant has already decided by navigating here, and an extra click
    // before anything is visible is a click that answers nothing.
    //
    // Upserted rather than select-then-insert, because this effect can run
    // twice before either pass commits — two loads both saw no proposal and
    // both inserted, and the second one failed on the unique key with a
    // database error shown to the consultant. Let the constraint arbitrate.
    const { data: proposal, error: proposalError } = await supabase()
      .from("proposals")
      .upsert({ client_id: clientId, grant_id: grantId }, { onConflict: "client_id, grant_id" })
      .select("id")
      .single();
    if (proposalError) {
      setError(proposalError.message);
      return;
    }
    const id = (proposal as { id: string }).id;
    setProposalId(id);

    const { data: reqs } = await supabase()
      .from("requirements")
      .select(
        "id, label, detail, kind, word_limit, evaluation_note, source_quote, is_critical, sort_order",
      )
      .eq("grant_id", grantId)
      .order("sort_order");
    setRequirements((reqs ?? []) as Requirement[]);

    const { data: secs } = await supabase()
      .from("proposal_sections")
      .select("id, requirement_id, heading, content, word_count, drafted_by, reused_answer_ids")
      .eq("proposal_id", id);

    const byRequirement: Record<string, Section> = {};
    for (const section of (secs ?? []) as Section[]) {
      if (section.requirement_id) byRequirement[section.requirement_id] = section;
    }
    setSections(byRequirement);

    const { data: acks } = await supabase()
      .from("requirement_acknowledgements")
      .select("requirement_id")
      .eq("proposal_id", id);
    setAcknowledged(
      new Set(((acks ?? []) as Array<{ requirement_id: string }>).map((a) => a.requirement_id)),
    );

    const { data: sent } = await supabase()
      .from("submissions")
      .select("submitted_at, outcome, confirmation_number")
      .eq("proposal_id", id)
      .maybeSingle();
    setSubmission(sent as typeof submission);
  }, [clientId, grantId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Read the call without being asked, once, when we have not read it yet.
   *
   * Arriving here is the decision; the button was pure latency in front of it.
   * It stays as "Re-read the call", because re-reading after a funder amends
   * their notice is a real choice a consultant makes deliberately.
   */
  useEffect(() => {
    if (autoRead.current || requirements === null || requirements.length > 0 || busy) return;
    autoRead.current = true;
    void readCall();
  }, [requirements, busy]);

  async function readCall() {
    setBusy("read");
    setError(null);
    setNote(null);
    try {
      const result = await runRead({ data: { grantId, accessToken: await accessToken() } });
      if (!result.ok) throw new Error(result.error);
      setNote(`Read ${result.count} requirements from ${result.provenance.source}.`);
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  /**
   * A heading the consultant read off the funder's own form.
   *
   * Stored as a requirement like any other, so it drafts, reuses answers and
   * carries a word limit the same way an extracted one does. The only thing it
   * lacks is a source quote, because there is no published sentence behind it.
   */
  async function addSection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const label = String(data.get("label") ?? "").trim();
    if (!label) return;

    const limit = Number(String(data.get("wordLimit") ?? "").replace(/\D/g, ""));

    setBusy("add");
    setError(null);
    setNote(null);
    try {
      const { error: insertError } = await supabase()
        .from("requirements")
        .upsert(
          {
            grant_id: grantId,
            label,
            kind: "section",
            word_limit: Number.isFinite(limit) && limit > 0 ? limit : null,
            sort_order: (requirements?.length ?? 0) + 100,
          },
          { onConflict: "grant_id, label" },
        );
      if (insertError) throw insertError;
      form.reset();
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  /**
   * A condition only the consultant can clear — audited statements, a signed
   * letter. The software cannot verify it, so it records that a person said
   * they have it, and who.
   */
  async function acknowledge(requirement: Requirement, has: boolean) {
    if (!proposalId) return;
    setError(null);

    // Flipped locally first. The write is a round-trip to Postgres, and a
    // checkbox that stays where it was for half a second reads as broken —
    // people click it again, which is how a confirmation gets toggled back off
    // without anyone noticing. Reverted below if the write actually fails.
    const optimistic = new Set(acknowledged);
    if (has) optimistic.add(requirement.id);
    else optimistic.delete(requirement.id);
    setAcknowledged(optimistic);

    // Cleared here, synchronously, and not after the write returns. Doing it
    // afterwards let a slow acknowledgement wipe the results of a readiness
    // check the consultant had already asked for since — the checklist simply
    // vanished, with no way to tell why.
    setBlockers(null);

    try {
      if (has) {
        const { data: user } = await supabase().auth.getUser();
        const { error: ackError } = await supabase().from("requirement_acknowledgements").upsert(
          {
            proposal_id: proposalId,
            requirement_id: requirement.id,
            acknowledged_by: user.user!.id,
          },
          { onConflict: "proposal_id, requirement_id" },
        );
        if (ackError) throw ackError;
      } else {
        await supabase()
          .from("requirement_acknowledgements")
          .delete()
          .eq("proposal_id", proposalId)
          .eq("requirement_id", requirement.id);
      }
      // Deliberately no reload on success. Reloading replaced the local set
      // with a snapshot taken before this write landed, so ticking several
      // conditions quickly un-ticked the earlier ones in front of the
      // consultant — the write had succeeded and the screen said otherwise.
    } catch (caught) {
      // On failure the server is the authority, so re-read. A confirmation that
      // looks recorded but is not is the one failure this screen exists to
      // prevent.
      await load();
      setError(errorMessage(caught));
    }
  }

  async function refreshReadiness() {
    if (!proposalId) return;
    setBusy("readiness");
    setError(null);
    try {
      const result = await runReadiness({ data: { proposalId, accessToken: await accessToken() } });
      if (!result.ok) throw new Error(result.error);
      setBlockers(result.blockers);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function send(override: boolean) {
    if (!proposalId) return;
    setBusy("submit");
    setError(null);
    setNote(null);
    try {
      const result = await runSubmit({
        data: { proposalId, overrideSoftBlockers: override, accessToken: await accessToken() },
      });
      if (!result.ok) {
        if (result.blockers) setBlockers(result.blockers);
        throw new Error(result.error);
      }
      setNote(
        result.overrode > 0
          ? `Recorded as submitted, over ${result.overrode} stated warning${result.overrode === 1 ? "" : "s"}. What you were told is stored with it.`
          : "Recorded as submitted.",
      );
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Record what the funder decided.
   *
   * Written straight from the browser: it needs no server-only capability, and
   * row-level security already governs who may touch this row. Routing it
   * through a server function would only move the check somewhere easier to
   * get wrong.
   */
  async function updateOutcome(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!proposalId) return;
    const form = new FormData(event.currentTarget);

    setBusy("outcome");
    setError(null);
    setNote(null);
    try {
      const reference = String(form.get("confirmationNumber") ?? "").trim();
      const { error: updateError } = await supabase()
        .from("submissions")
        .update({
          outcome: String(form.get("outcome") ?? "awaiting"),
          confirmation_number: reference || null,
        })
        .eq("proposal_id", proposalId);
      if (updateError) throw updateError;
      setNote("Outcome saved.");
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function loadAwards() {
    setBusy("awards");
    setError(null);
    try {
      const result = await runPastAwards({ data: { grantId, accessToken: await accessToken() } });
      if (!result.ok) throw new Error(result.error);
      setAwards(result.result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function draft(requirement: Requirement) {
    if (!proposalId) return;
    setBusy(requirement.id);
    setError(null);
    setNote(null);
    try {
      const result = await runDraft({
        data: {
          clientId,
          proposalId,
          requirementId: requirement.id,
          accessToken: await accessToken(),
        },
      });
      if (!result.ok) throw new Error(result.error);
      setNote(
        result.reused.length > 0
          ? `Drafted ${result.wordCount} words, reusing ${result.reused.map((r) => `"${r.label}"`).join(", ")}.`
          : `Drafted ${result.wordCount} words. Nothing in the answer library matched yet.`,
      );
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function keepAnswer(requirement: Requirement, content: string) {
    setBusy(requirement.id);
    setError(null);
    try {
      const result = await runSaveAnswer({
        data: {
          clientId,
          label: requirement.label,
          content,
          accessToken: await accessToken(),
        },
      });
      if (!result.ok) throw new Error(result.error);
      setNote(`Kept "${requirement.label}" — the next call that asks this will reuse it.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit(requirement: Requirement, content: string) {
    if (!proposalId) return;
    const { error: saveError } = await supabase()
      .from("proposal_sections")
      .upsert(
        {
          proposal_id: proposalId,
          requirement_id: requirement.id,
          heading: requirement.label,
          content,
          word_count: content.trim().split(/\s+/).filter(Boolean).length,
          // Edited by a person, so the previous model attribution no longer
          // describes it. Leaving it would misattribute the consultant's words.
          drafted_by: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "proposal_id, requirement_id" },
      );
    if (saveError) setError(errorMessage(saveError));
    else await load();
  }

  const writable = (requirements ?? []).filter((r) => r.kind === "section");
  const conditions = (requirements ?? []).filter((r) => r.kind !== "section");
  const drafted = writable.filter((r) => sections[r.id]?.content).length;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link
        to="/clients/$clientId/matches"
        params={{ clientId }}
        className="text-sm text-[var(--color-accent)]"
      >
        ← Matches
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        {grant?.title ?? "Application"}
      </h1>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
        {grant?.deadline ? `Closes ${grant.deadline}. ` : ""}
        <a
          href={grant?.url}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-accent)]"
        >
          The call itself
        </a>
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={readCall}
          disabled={busy !== null}
          data-testid="read-call"
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy === "read"
            ? "Reading the call…"
            : requirements?.length
              ? "Re-read the call"
              : "Read what this call requires"}
        </button>
        <button
          type="button"
          onClick={loadAwards}
          disabled={busy !== null}
          data-testid="past-awards"
          className="rounded-md border border-[var(--color-rule)] px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy === "awards" ? "Looking up…" : "Who has won this before"}
        </button>
        {writable.length > 0 && (
          <span data-testid="draft-progress" className="text-sm text-[var(--color-ink-soft)]">
            {drafted} of {writable.length} sections drafted
          </span>
        )}
      </div>

      {/* The first question a consultant asks about a call: does this funder
          give to organizations like mine, or to hospitals and universities? */}
      {awards && (
        <section className="mt-6" data-testid="awards-panel">
          {awards.known ? (
            awards.awards.length > 0 ? (
              <>
                <p className="text-sm text-[var(--color-ink-soft)]">
                  Largest recent awards under assistance listing {awards.listing}:
                </p>
                <ul className="mt-2 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
                  {awards.awards.slice(0, 8).map((award) => (
                    <li
                      key={award.externalId}
                      className="flex items-baseline justify-between gap-3 bg-[var(--color-surface)] px-4 py-2 text-sm"
                    >
                      <span>
                        {award.recipientName}
                        {award.location && (
                          <span className="text-[var(--color-ink-soft)]"> · {award.location}</span>
                        )}
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--color-ink-soft)]">
                        {award.amount ? `$${Math.round(award.amount).toLocaleString()}` : "—"}
                        {award.awardedOn && ` · ${award.awardedOn.slice(0, 4)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-[var(--color-ink-soft)]">
                No awards are published under listing {awards.listing} yet.
              </p>
            )
          ) : (
            // Not an empty list: "nobody has ever won this" is a much stronger
            // claim than "we cannot see it", and only one of them is true.
            <p className="text-sm text-[var(--color-ink-soft)]">{awards.reason}</p>
          )}
        </section>
      )}

      {note && <p className="mt-3 text-sm text-[var(--color-ink-soft)]">{note}</p>}
      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--color-ineligible)]">
          {error}
        </p>
      )}

      {requirements !== null && requirements.length === 0 && (
        <p className="mt-8 text-sm text-[var(--color-ink-soft)]">
          We could not read requirements from this call. Add the headings from the funder's form
          below and we will draft against them.
        </p>
      )}

      {conditions.length > 0 && (
        <section className="mt-10" data-testid="conditions">
          <h2 className="text-sm font-semibold">Before you write</h2>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            Conditions and attachments the call names. Nothing here is drafted — these are things
            only you can produce.
          </p>
          <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
            {conditions.map((requirement) => (
              <li key={requirement.id} className="bg-[var(--color-surface)] px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium">{requirement.label}</span>
                  <span className="shrink-0 text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
                    {requirement.is_critical ? "required" : requirement.kind}
                  </span>
                </div>
                {requirement.detail && (
                  <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{requirement.detail}</p>
                )}
                {/* Software cannot verify that audited statements exist. What it
                    can do is refuse to call the application ready until a person
                    says they have them — and record who said so. */}
                {requirement.is_critical && (
                  <label className="mt-2 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={acknowledged.has(requirement.id)}
                      onChange={(event) => acknowledge(requirement, event.target.checked)}
                      disabled={!!submission}
                    />
                    I have this
                  </label>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {requirements !== null && requirements.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold">What they asked you to write</h2>

          {writable.length === 0 && (
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              This call publishes its conditions but not its section list — most funders keep that
              in the application form or a PDF. Add the headings from the form and we will draft
              against them.
            </p>
          )}

          <ul className="mt-3 flex flex-col gap-4">
            {writable.map((requirement) => (
              <SectionCard
                key={requirement.id}
                requirement={requirement}
                section={sections[requirement.id]}
                busy={busy === requirement.id}
                disabled={busy !== null}
                onDraft={() => draft(requirement)}
                onSave={(content) => saveEdit(requirement, content)}
                onKeep={(content) => keepAnswer(requirement, content)}
              />
            ))}
          </ul>

          {/* The escape hatch that makes this usable on real calls. Extraction
              reads what the funder published on the web; the section list often
              lives in the form itself, and without this the consultant is stuck
              looking at a correct but useless page. */}
          <form onSubmit={addSection} className="mt-4 flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1">
              <label
                htmlFor="new-section"
                className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]"
              >
                Add a section from their form
              </label>
              <input
                id="new-section"
                name="label"
                required
                placeholder="Project Description"
                className="mt-1 w-full rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 py-2 text-sm"
              />
            </div>
            <input
              name="wordLimit"
              inputMode="numeric"
              placeholder="Word limit"
              aria-label="Word limit"
              className="w-32 rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={busy !== null}
              data-testid="add-section"
              className="rounded-md border border-[var(--color-rule)] px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              Add section
            </button>
          </form>
        </section>
      )}

      {requirements !== null && requirements.length > 0 && (
        <section className="mt-12 border-t border-[var(--color-rule)] pt-8" data-testid="send">
          <h2 className="text-sm font-semibold">Ready to send?</h2>

          {submission ? (
            <>
              <p data-testid="submitted" className="mt-2 text-sm">
                <span className="font-medium text-[var(--color-eligible)]">Submitted</span>{" "}
                {new Date(submission.submitted_at).toLocaleDateString()} · {submission.outcome}
                {submission.confirmation_number && ` · ref ${submission.confirmation_number}`}
              </p>

              {/* The other half of "submit and track". Without this, outcome had
                  four states and exactly one reachable: the product claimed to
                  track what happened and could only ever say "awaiting". A
                  consultant updates this months later, between other work,
                  which is why it is two fields rather than a workflow. */}
              <form
                onSubmit={updateOutcome}
                data-testid="outcome-form"
                className="mt-4 flex flex-wrap items-end gap-2"
              >
                <div>
                  <label
                    htmlFor="outcome"
                    className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]"
                  >
                    What happened
                  </label>
                  <select
                    id="outcome"
                    name="outcome"
                    key={submission.outcome ?? "awaiting"}
                    defaultValue={submission.outcome ?? "awaiting"}
                    className="mt-1 block rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 py-2 text-sm"
                  >
                    <option value="awaiting">Awaiting a decision</option>
                    <option value="awarded">Awarded</option>
                    <option value="declined">Declined</option>
                    <option value="withdrawn">Withdrawn</option>
                  </select>
                </div>
                <div className="min-w-48 flex-1">
                  <label
                    htmlFor="confirmation"
                    className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]"
                  >
                    Their reference number
                  </label>
                  <input
                    id="confirmation"
                    name="confirmationNumber"
                    key={submission.confirmation_number ?? ""}
                    defaultValue={submission.confirmation_number ?? ""}
                    placeholder="From their acknowledgement email"
                    className="mt-1 w-full rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 py-2 text-sm"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busy !== null}
                  data-testid="save-outcome"
                  className="rounded-md border border-[var(--color-rule)] px-3 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {busy === "outcome" ? "Saving…" : "Save"}
                </button>
              </form>
            </>
          ) : (
            <>
              <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-soft)]">
                Every check below is decided from what is in the application, not from an opinion
                about it. The last one is you.
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={refreshReadiness}
                  disabled={busy !== null}
                  data-testid="check-readiness"
                  className="rounded-md border border-[var(--color-rule)] px-4 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {busy === "readiness" ? "Checking…" : "Check what is left"}
                </button>

                {blockers !== null && (
                  <button
                    type="button"
                    onClick={() => send(blockers.some((b) => b.key !== "not_reviewed"))}
                    disabled={
                      busy !== null || blockers.some((b) => b.isHard && b.key !== "not_reviewed")
                    }
                    data-testid="submit-proposal"
                    className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {busy === "submit"
                      ? "Recording…"
                      : blockers.some((b) => b.key !== "not_reviewed")
                        ? "I have read it — submit anyway"
                        : "I have read it — record as submitted"}
                  </button>
                )}
              </div>

              {blockers !== null && (
                <ul data-testid="blockers" className="mt-4 flex flex-col gap-2">
                  {blockers.length === 0 && (
                    <li className="text-sm text-[var(--color-eligible)]">
                      Nothing is outstanding. Confirming above records the submission.
                    </li>
                  )}
                  {blockers.map((blocker) => (
                    <li key={blocker.key} className="flex gap-2 text-sm">
                      <span
                        className={
                          blocker.isHard
                            ? "text-[var(--color-ineligible)]"
                            : "text-[var(--color-needs-input)]"
                        }
                      >
                        {blocker.isHard ? "✗" : "!"}
                      </span>
                      <span>{blocker.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}

function SectionCard({
  requirement,
  section,
  busy,
  disabled,
  onDraft,
  onSave,
  onKeep,
}: {
  requirement: Requirement;
  section: Section | undefined;
  busy: boolean;
  disabled: boolean;
  onDraft: () => void;
  onSave: (content: string) => void;
  onKeep: (content: string) => void;
}) {
  const [text, setText] = useState(section?.content ?? "");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setText(section?.content ?? "");
  }, [section?.content, dirty]);

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const overLimit = requirement.word_limit !== null && words > requirement.word_limit;
  // A gap the model marked rather than invented. Surfaced deliberately: it is
  // the fastest thing on the page to fix and the most damaging to miss.
  const gaps = (text.match(/\[NEED:[^\]]*\]/g) ?? []).length;

  return (
    <li
      className="rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-4"
      data-testid="section-card"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">{requirement.label}</h3>
        <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--color-ink-soft)]">
          {requirement.word_limit ? (
            <span className={overLimit ? "text-[var(--color-ineligible)]" : undefined}>
              {words}/{requirement.word_limit} words
            </span>
          ) : words > 0 ? (
            `${words} words`
          ) : null}
        </span>
      </div>

      {requirement.detail && (
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{requirement.detail}</p>
      )}
      {requirement.evaluation_note && (
        <p className="mt-1 text-sm">
          <span className="text-[var(--color-ink-soft)]">Scored on: </span>
          {requirement.evaluation_note}
        </p>
      )}
      {requirement.source_quote && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-[var(--color-ink-soft)]">
            What the call says
          </summary>
          <blockquote className="mt-1 border-l-2 border-[var(--color-rule)] pl-3 text-xs italic">
            {requirement.source_quote}
          </blockquote>
        </details>
      )}

      <textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setDirty(true);
        }}
        rows={text ? 10 : 3}
        placeholder="Draft it, or write it yourself."
        aria-label={requirement.label}
        className="mt-3 w-full rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] p-3 text-sm"
      />

      {gaps > 0 && (
        <p className="mt-1 text-sm text-[var(--color-needs-input)]">
          {gaps} gap{gaps === 1 ? "" : "s"} marked <code>[NEED: …]</code> — facts we did not have
          and would not invent.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onDraft}
          disabled={disabled}
          className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Writing…" : section?.content ? "Draft again" : "Draft this"}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              onSave(text);
              setDirty(false);
            }}
            disabled={disabled}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Save
          </button>
        )}
        {text.length > 40 && (
          <button
            type="button"
            onClick={() => onKeep(text)}
            disabled={disabled}
            className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Keep for next time
          </button>
        )}
        {section?.drafted_by && (
          <span className="text-xs text-[var(--color-ink-soft)]">
            Drafted by {section.drafted_by}
            {section.reused_answer_ids.length > 0 &&
              `, reusing ${section.reused_answer_ids.length} saved answer${
                section.reused_answer_ids.length === 1 ? "" : "s"
              }`}
          </span>
        )}
      </div>
    </li>
  );
}
