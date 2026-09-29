import { createFileRoute, Link } from "@tanstack/react-router";
import { OpportunityBrief } from "@/components/OpportunityBrief";
import { AwardPanel } from "@/components/AwardPanel";
import type { DraftingGate } from "@/lib/go-decision";
import { CallSnapshot, type CallSnapshotGrant } from "@/components/CallSnapshot";
import { formatMoney } from "@/lib/money";
import { useRequireSession } from "@/lib/use-require-session";
import { useDocumentTitle } from "@/lib/use-document-title";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { accessToken } from "@/lib/session";
import { errorMessage } from "@/lib/error-message";
import { useAction } from "@/lib/use-action";
import {
  assessRequirement,
  draftProposalSection,
  readRequirements,
  saveToAnswerLibrary,
} from "@/server/proposal.functions";
import { checkReadiness, getPastAwards, submitProposal } from "@/server/submit.functions";
import type { Blocker } from "@/lib/submit-gate";
import { DOCUMENT_COLUMNS, type ClientDocument } from "@/components/DocumentRegister";
import { KIND_LABEL, documentStatus } from "@/lib/client-documents";
import type { PastAwardsResult } from "@/server/past-awards";
import { memberName, type Assignment, type TeamMember } from "@/lib/assignments";

const OUTCOME_LABEL: Record<string, string> = {
  awaiting: "Awaiting a decision",
  awarded: "Awarded",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

export const Route = createFileRoute("/clients_/$clientId/proposals/$grantId")({
  component: ProposalPage,
});

type Requirement = {
  id: string;
  label: string;
  detail: string | null;
  kind: "section" | "eligibility" | "attachment" | "criterion" | "process";
  word_limit: number | null;
  evaluation_note: string | null;
  source_quote: string | null;
  is_critical: boolean;
  sort_order: number;
};

type AssignmentPatch = Partial<Pick<Assignment, "ownerId" | "dueOn" | "doneAt">>;

type Section = {
  id: string;
  requirement_id: string | null;
  heading: string;
  content: string | null;
  word_count: number | null;
  drafted_by: string | null;
  reused_answer_ids: string[];
  fabrication_concerns: { kind: "number" | "spelled-number" | "person"; text: string }[];
  /** The version this page loaded, so a save can tell if someone saved since. */
  updated_at: string;
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
  useRequireSession();
  const { clientId, grantId } = Route.useParams();
  const runRead = useServerFn(readRequirements);
  const runDraft = useServerFn(draftProposalSection);
  const runSaveAnswer = useServerFn(saveToAnswerLibrary);
  const runReadiness = useServerFn(checkReadiness);
  const runSubmit = useServerFn(submitProposal);
  const runPastAwards = useServerFn(getPastAwards);
  const runAssess = useServerFn(assessRequirement);

  const [grant, setGrant] = useState<CallSnapshotGrant | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<Requirement[] | null>(null);
  const [sections, setSections] = useState<Record<string, Section>>({});
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [locations, setLocations] = useState<Record<string, string>>({});
  const [linked, setLinked] = useState<Record<string, string>>({});
  const [registerDocs, setRegisterDocs] = useState<ClientDocument[]>([]);
  const [submission, setSubmission] = useState<{
    submitted_at: string;
    outcome: string | null;
    confirmation_number: string | null;
  } | null>(null);
  const [blockers, setBlockers] = useState<Blocker[] | null>(null);
  const [awards, setAwards] = useState<PastAwardsResult | null>(null);
  const [readText, setReadText] = useState<string | null>(null);
  const [concerns, setConcerns] = useState<string[]>([]);
  const [assessments, setAssessments] = useState<Record<string, string>>({});
  const [gate, setGate] = useState<DraftingGate>({ allowed: true });
  const [assignments, setAssignments] = useState<Record<string, Assignment>>({});
  const [team, setTeam] = useState<TeamMember[]>([]);
  const assessing = useRef(new Set<string>());
  const assessFailed = useRef(new Set<string>());
  const { busy, error, note, run, setError } = useAction();
  const autoRead = useRef(false);
  /** Acknowledgement writes that have not reached Postgres yet. */
  const pendingAcks = useRef(new Set<Promise<unknown>>());

  const load = useCallback(async () => {
    const { data: grantRow, error: grantError } = await supabase()
      .from("grants")
      .select(
        "title, url, deadline, summary, eligibility_note, status, currency, amount_min, " +
          "amount_max, country, documents, contact, source_key, last_seen_at, funders(name, website), " +
          "estimated_deadline, cost_sharing_required, deadline_note, opportunity_number",
      )
      .eq("id", grantId)
      .maybeSingle();
    if (grantError) {
      setError(grantError.message);
      return;
    }
    if (!grantRow) {
      setError("This call is not in the catalog, or you do not have access to it.");
      return;
    }
    setGrant(grantRow as unknown as NonNullable<typeof grant>);

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

    // Shared extracted requirements plus the headings typed for this client
    // only — never another client's, even one this consultant also serves.
    const [reqResult, secResult, ackResult, assessResult, sentResult, docResult, assignResult, teamResult] =
      await Promise.all([
        supabase()
          .from("requirements")
          .select(
            "id, label, detail, kind, word_limit, evaluation_note, source_quote, is_critical, sort_order",
          )
          .eq("grant_id", grantId)
          .or(`client_id.is.null,client_id.eq.${clientId}`)
          .order("sort_order"),
        supabase()
          .from("proposal_sections")
          .select(
            "id, requirement_id, heading, content, word_count, drafted_by, reused_answer_ids, fabrication_concerns, updated_at",
          )
          .eq("proposal_id", id),
        supabase()
          .from("requirement_acknowledgements")
          .select("requirement_id, location, document_id")
          .eq("proposal_id", id),
        supabase()
          .from("requirement_assessments")
          .select("requirement_id, assessment")
          .eq("proposal_id", id),
        supabase()
          .from("submissions")
          .select("submitted_at, outcome, confirmation_number")
          .eq("proposal_id", id)
          .order("submitted_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase().from("client_documents").select(DOCUMENT_COLUMNS).eq("client_id", clientId),
        supabase()
          .from("requirement_assignments")
          .select("requirement_id, owner_id, due_on, done_at")
          .eq("proposal_id", id),
        supabase().rpc("client_team_roster", { target: clientId }),
      ]);
    // A failed read must say so: an empty list here reads as "the call asks
    // for nothing" or "nothing is drafted", both of which are false.
    const failed = [
      reqResult,
      secResult,
      ackResult,
      assessResult,
      sentResult,
      assignResult,
      docResult,
      teamResult,
    ].find((r) => r.error);
    if (failed?.error) {
      setError(failed.error.message);
      return;
    }
    setRequirements((reqResult.data ?? []) as Requirement[]);
    const secs = secResult.data;

    const byRequirement: Record<string, Section> = {};
    for (const section of (secs ?? []) as Section[]) {
      if (section.requirement_id) byRequirement[section.requirement_id] = section;
    }
    setSections(byRequirement);

    const ackRows = (ackResult.data ?? []) as Array<{
      requirement_id: string;
      location: string | null;
      document_id: string | null;
    }>;
    setRegisterDocs((docResult.data ?? []) as ClientDocument[]);
    setLinked(
      Object.fromEntries(
        ackRows.filter((a) => a.document_id).map((a) => [a.requirement_id, a.document_id!]),
      ),
    );
    setAcknowledged(new Set(ackRows.map((a) => a.requirement_id)));
    setLocations(
      Object.fromEntries(
        ackRows.filter((a) => a.location).map((a) => [a.requirement_id, a.location!]),
      ),
    );

    setAssessments(
      Object.fromEntries(
        ((assessResult.data ?? []) as Array<{ requirement_id: string; assessment: string }>).map(
          (a) => [a.requirement_id, a.assessment],
        ),
      ),
    );
    setSubmission(sentResult.data as typeof submission);
    setAssignments(
      Object.fromEntries(
        (
          (assignResult.data ?? []) as Array<{
            requirement_id: string;
            owner_id: string | null;
            due_on: string | null;
            done_at: string | null;
          }>
        ).map((a) => [
          a.requirement_id,
          {
            requirementId: a.requirement_id,
            ownerId: a.owner_id,
            dueOn: a.due_on,
            doneAt: a.done_at,
          },
        ]),
      ),
    );
    setTeam(
      (
        (teamResult.data ?? []) as Array<{
          client_id: string;
          user_id: string;
          email: string;
          display_name: string | null;
          is_owner: boolean;
        }>
      ).map((m) => ({
        clientId: m.client_id,
        userId: m.user_id,
        email: m.email,
        displayName: m.display_name,
        isOwner: m.is_owner,
      })),
    );
  }, [clientId, grantId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Read the call without being asked, once, when we have not read it yet —
   * then ask who this funder has actually funded before, the other button
   * that used to sit here for no reason except that clicking it was possible.
   *
   * "Who has won this before" is cheap (a lookup, not a model call) and is,
   * per the comment on its own panel below, the first question a consultant
   * asks about a call — the same reasoning that already justified reading the
   * call itself without a click. It is chained after the read rather than
   * fired alongside it: both actions share one busy slot, and starting a
   * second one before the first's state update has landed would stomp it —
   * this page has no per-action tracking to make firing them together safe.
   *
   * The read stays "Re-read the call" afterward, because re-reading after a
   * funder amends their notice is a real choice a consultant makes
   * deliberately — awards, on the other hand, do not need a re-ask button;
   * whoever it funded stays fetchable on request from its own button either way.
   */
  useEffect(() => {
    if (autoRead.current || requirements === null || busy) return;
    autoRead.current = true;
    const afterRead = () => {
      if (awards === null) void loadAwards();
    };
    if (requirements.length > 0) afterRead();
    else void readCall().then(afterRead);
  }, [requirements, busy]);

  /**
   * Read every critical condition against this client's profile, without
   * being asked — the same idiom as the call itself and the awards lookup,
   * for the same reason: re-reading a funder's "Who can apply?" paragraph
   * against a client's own profile by hand, once per critical condition, on
   * every call, was exactly the kind of manual work automating this was for.
   *
   * Kept out of the shared busy/run() machinery on purpose. Several
   * conditions can exist on one call, each needs its own independent request,
   * and run() only tracks one busy key at a time — the same reason
   * acknowledging a condition does not use it either. A failure here stays
   * silent: the funder's own quote and the checkbox are still there
   * regardless, and a page-wide error for an optional reading aid would
   * overstate what it is.
   */
  useEffect(() => {
    if (!proposalId || requirements === null) return;
    for (const requirement of requirements) {
      if (
        requirement.is_critical &&
        (requirement.kind === "eligibility" || requirement.kind === "attachment") &&
        !assessments[requirement.id] &&
        !assessing.current.has(requirement.id) &&
        !assessFailed.current.has(requirement.id)
      ) {
        void assessOne(requirement);
      }
    }
  }, [proposalId, requirements, assessments]);

  async function assessOne(requirement: Requirement) {
    if (!proposalId) return;
    assessing.current.add(requirement.id);
    try {
      const result = await runAssess({
        data: {
          clientId,
          proposalId,
          requirementId: requirement.id,
          accessToken: await accessToken(),
        },
      });
      if (result.ok) {
        setAssessments((current) => ({ ...current, [requirement.id]: result.assessment }));
      } else {
        assessFailed.current.add(requirement.id);
      }
    } catch {
      // Remembered so the effect does not retry it on every other success —
      // each retry is a model call charged against the drafting budget.
      assessFailed.current.add(requirement.id);
    } finally {
      assessing.current.delete(requirement.id);
    }
  }

  const readCall = () =>
    run("read", async () => {
      const result = await runRead({ data: { grantId, accessToken: await accessToken() } });
      if (!result.ok) throw new Error(result.error);

      // Kept regardless of whether structure came out of it — a call that
      // publishes its conditions clearly and its section list nowhere at all
      // leaves "Add a section" to a guess otherwise, and the raw text was
      // already read to get here either way.
      setReadText(result.readText);
      setConcerns(result.concerns);

      if (!result.found) {
        // Real text was read; nothing structured came out of it. Shown in
        // place of a dead end that used to just point back at the source —
        // this is what was actually looked at, in the app.
        return (
          `Read ${result.provenance.source}, but could not tell its requirements from its ` +
          `prose. What was read is shown below — add the headings its form asks for.`
        );
      }

      await load();
      return `Read ${result.count} requirements from ${result.provenance.source}.`;
    });

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

    // Already on the call under that heading: work on that one rather than
    // creating a second, identically named section beside it.
    const existing = (requirements ?? []).find(
      (r) => r.label.trim().toLowerCase() === label.toLowerCase(),
    );
    if (existing) {
      form.reset();
      setError(null);
      return;
    }

    await run("add", async () => {
      const { error: insertError } = await supabase()
        .from("requirements")
        .upsert(
          {
            grant_id: grantId,
            // Belongs to this client's application, not to the shared call.
            client_id: clientId,
            label,
            kind: "section",
            word_limit: Number.isFinite(limit) && limit > 0 ? limit : null,
            sort_order: (requirements?.length ?? 0) + 100,
          },
          { onConflict: "grant_id, label, client_id" },
        );
      if (insertError) throw insertError;
      form.reset();
      await load();
    });
  }

  /**
   * A condition only the consultant can clear — audited statements, a signed
   * letter. The software cannot verify it, so it records that a person said
   * they have it, and who.
   */
  async function acknowledge(requirement: Requirement, has: boolean) {
    if (!proposalId) return;
    setError(null);

    const settled = acknowledgeInFlight(requirement, has);
    pendingAcks.current.add(settled);
    void settled.finally(() => pendingAcks.current.delete(settled));
    await settled;
  }

  /**
   * Where the file actually is — a Drive link, a shared-folder path, "with
   * the bookkeeper" — recorded against the same acknowledgement row rather
   * than only a checkbox saying it exists. No file storage runs in this
   * stack yet, so this is the leaner form of the same idea: a checklist that
   * says where to look, not just that something was once confirmed.
   */
  async function saveLocation(requirement: Requirement, location: string) {
    if (!proposalId || !acknowledged.has(requirement.id)) return;
    const before = locations[requirement.id];
    setLocations((current) => ({ ...current, [requirement.id]: location }));
    const { error: locationError } = await supabase()
      .from("requirement_acknowledgements")
      .update({ location: location.trim() || null })
      .eq("proposal_id", proposalId)
      .eq("requirement_id", requirement.id);
    // Put back only this field, and say so: a location that looks saved and
    // is not is how an attachment goes missing on submission day.
    if (locationError) {
      setLocations((current) => ({ ...current, [requirement.id]: before ?? "" }));
      setError(`Could not save where "${requirement.label}" is: ${locationError.message}`);
    }
  }

  /**
   * Link a document from the client's register and take its location, so the
   * submit gate can check its expiry against the deadline.
   */
  async function linkFromRegister(requirement: Requirement, documentId: string) {
    if (!proposalId || !acknowledged.has(requirement.id)) return;
    const doc = registerDocs.find((d) => d.id === documentId);
    const beforeLinked = linked[requirement.id];
    const beforeLocation = locations[requirement.id];
    setLinked((current) => {
      const next = { ...current };
      if (doc) next[requirement.id] = doc.id;
      else delete next[requirement.id];
      return next;
    });
    if (doc) setLocations((current) => ({ ...current, [requirement.id]: doc.location }));
    setBlockers(null);
    const { error: linkError } = await supabase()
      .from("requirement_acknowledgements")
      .update(doc ? { document_id: doc.id, location: doc.location } : { document_id: null })
      .eq("proposal_id", proposalId)
      .eq("requirement_id", requirement.id);
    if (linkError) {
      setLinked((current) => {
        const next = { ...current };
        if (beforeLinked) next[requirement.id] = beforeLinked;
        else delete next[requirement.id];
        return next;
      });
      setLocations((current) => ({ ...current, [requirement.id]: beforeLocation ?? "" }));
      setError(`Could not link a document to "${requirement.label}": ${linkError.message}`);
      return;
    }
    void refreshReadiness();
  }

  /**
   * The write itself, kept separate so the caller can hold onto its promise.
   *
   * The checkbox flips locally and the round-trip to Postgres finishes later,
   * which is right for the checkbox and wrong for anything that reads the
   * server afterwards: a consultant who ticks a condition and immediately asks
   * for a readiness check gets told the condition is outstanding, naming a
   * requirement they can see themselves having confirmed. The confirmation was
   * never lost — the question was asked too early. So the readiness check waits
   * for these, and only these.
   */
  async function acknowledgeInFlight(requirement: Requirement, has: boolean) {
    // Flipped locally first. The write is a round-trip to Postgres, and a
    // checkbox that stays where it was for half a second reads as broken —
    // people click it again, which is how a confirmation gets toggled back off
    // without anyone noticing. Reverted below if the write actually fails.
    // Functional, so two quick ticks both land: a set copied from this
    // render's closure would drop whichever tick came first.
    setAcknowledged((current) => {
      const next = new Set(current);
      if (has) next.add(requirement.id);
      else next.delete(requirement.id);
      return next;
    });

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
        const { error: deleteError } = await supabase()
          .from("requirement_acknowledgements")
          .delete()
          .eq("proposal_id", proposalId)
          .eq("requirement_id", requirement.id);
        if (deleteError) throw deleteError;
        setLinked((current) => {
          const next = { ...current };
          delete next[requirement.id];
          return next;
        });
      }
      // Deliberately no reload on success. Reloading replaced the local set
      // with a snapshot taken before this write landed, so ticking several
      // conditions quickly un-ticked the earlier ones in front of the
      // consultant — the write had succeeded and the screen said otherwise.
      //
      // Readiness is different: it was cleared above rather than reloaded,
      // and used to just stay cleared until a separate click asked for it
      // again — one more click per condition ticked, for a check that costs
      // nothing to run (it is pure, no model call). refreshReadiness() itself
      // already waits out every acknowledgement still in flight before it
      // reads anything, which is exactly what ticking several boxes quickly
      // needs: the last one to settle is the one whose result sticks.
      void refreshReadiness();
    } catch (caught) {
      // Revert this one box, and only this one. Re-reading the whole set here
      // clobbered the optimistic state of the acknowledgements still in flight
      // beside it — ticking several conditions quickly, one failure silently
      // dropped its neighbours, and the submit gate then refused for a
      // condition the consultant had visibly confirmed.
      setAcknowledged((current) => {
        const reverted = new Set(current);
        if (has) reverted.delete(requirement.id);
        else reverted.add(requirement.id);
        return reverted;
      });
      setError(errorMessage(caught));
    }
  }

  /**
   * Owner, internal due date or done, one field at a time. Optimistic and
   * functional like acknowledgements: several quick changes must all land,
   * and a failure puts back only the fields that failed.
   */
  async function assign(requirement: Requirement, patch: AssignmentPatch) {
    if (!proposalId) return;
    setError(null);
    const empty: Assignment = {
      requirementId: requirement.id,
      ownerId: null,
      dueOn: null,
      doneAt: null,
    };
    const previous = { ...empty, ...assignments[requirement.id] };
    const keys = Object.keys(patch) as Array<keyof AssignmentPatch>;
    setAssignments((current) => ({
      ...current,
      [requirement.id]: { ...empty, ...current[requirement.id], ...patch },
    }));
    setBlockers(null);

    const columns: Record<string, string | null> = {};
    if ("ownerId" in patch) columns.owner_id = patch.ownerId ?? null;
    if ("dueOn" in patch) columns.due_on = patch.dueOn ?? null;
    if ("doneAt" in patch) columns.done_at = patch.doneAt ?? null;
    const { error: assignError } = await supabase()
      .from("requirement_assignments")
      .upsert(
        { proposal_id: proposalId, requirement_id: requirement.id, ...columns },
        { onConflict: "proposal_id, requirement_id" },
      );
    if (assignError) {
      setAssignments((current) => {
        const reverted: Assignment = { ...empty, ...current[requirement.id] };
        for (const key of keys) reverted[key] = previous[key];
        return { ...current, [requirement.id]: reverted };
      });
      setError(`Could not save who has "${requirement.label}": ${errorMessage(assignError)}`);
    }
  }

  const refreshReadiness = () =>
    run("readiness", async () => {
      if (!proposalId) return;
      // Any confirmation still travelling to Postgres has to land first, or
      // the gate answers about a state the consultant has already left.
      await Promise.allSettled([...pendingAcks.current]);
      const result = await runReadiness({ data: { proposalId, accessToken: await accessToken() } });
      if (!result.ok) throw new Error(result.error);
      setBlockers(result.blockers);
    });

  const send = (override: boolean) =>
    run("submit", async () => {
      if (!proposalId) return;
      const result = await runSubmit({
        data: { proposalId, overrideSoftBlockers: override, accessToken: await accessToken() },
      });
      if (!result.ok) {
        if (result.blockers) setBlockers(result.blockers);
        throw new Error(result.error);
      }
      await load();
      return result.overrode > 0
        ? `Recorded as submitted, over ${result.overrode} stated warning${result.overrode === 1 ? "" : "s"}. What you were told is stored with it.`
        : "Recorded as submitted.";
    });

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
    const form = new FormData(event.currentTarget);

    await run("outcome", async () => {
      if (!proposalId) return;
      const reference = String(form.get("confirmationNumber") ?? "").trim();
      const { error: updateError } = await supabase()
        .from("submissions")
        .update({
          outcome: String(form.get("outcome") ?? "awaiting"),
          confirmation_number: reference || null,
        })
        .eq("proposal_id", proposalId);
      if (updateError) throw updateError;
      await load();
      return "Outcome saved.";
    });
  }

  const loadAwards = () =>
    run("awards", async () => {
      const result = await runPastAwards({ data: { grantId, accessToken: await accessToken() } });
      if (!result.ok) throw new Error(result.error);
      setAwards(result.result);
    });

  const draft = (requirement: Requirement) =>
    run(requirement.id, async () => {
      if (!proposalId) return;
      const result = await runDraft({
        data: {
          clientId,
          proposalId,
          requirementId: requirement.id,
          accessToken: await accessToken(),
        },
      });
      if (!result.ok) throw new Error(result.error);
      await load();
      return result.reused.length > 0
        ? `Drafted ${result.wordCount} words, reusing ${result.reused.map((r) => `"${r.label}"`).join(", ")}.`
        : `Drafted ${result.wordCount} words. Nothing in the answer library matched yet.`;
    });

  const keepAnswer = (requirement: Requirement, content: string) =>
    run(requirement.id, async () => {
      const result = await runSaveAnswer({
        data: { clientId, label: requirement.label, content, accessToken: await accessToken() },
      });
      if (!result.ok) throw new Error(result.error);
      return `Kept "${requirement.label}" — the next call that asks this will reuse it.`;
    });

  async function saveEdit(requirement: Requirement, content: string): Promise<boolean> {
    if (!proposalId) return false;
    // One call, under a row lock: the database keeps its own current text as
    // the previous version, and refuses if someone saved since this page
    // loaded — the other person's words were being overwritten unrecorded.
    const { error: saveError } = await supabase().rpc("save_section", {
      target_proposal: proposalId,
      target_requirement: requirement.id,
      new_heading: requirement.label,
      new_content: content,
      new_word_count: content.trim().split(/\s+/).filter(Boolean).length,
      // Edited by a person, so the previous model attribution no longer
      // describes it. Leaving it would misattribute the consultant's words.
      new_drafted_by: null,
      // The fabrication check ran against the model's draft, not this edit.
      new_fabrication_concerns: [],
      new_reused_answer_ids: sections[requirement.id]?.reused_answer_ids ?? [],
      expected_updated_at: sections[requirement.id]?.updated_at ?? null,
    });
    if (saveError) {
      setError(
        /changed by someone else/.test(saveError.message)
          ? "Not saved — someone else saved this section since you opened it. Copy your text, reload the page, and merge."
          : errorMessage(saveError),
      );
      return false;
    }
    await load();
    return true;
  }

  useDocumentTitle(grant?.title, "Application");
  const writable = (requirements ?? []).filter((r) => r.kind === "section");
  const conditions = (requirements ?? []).filter(
    (r) => r.kind !== "section" && r.kind !== "process",
  );
  // Instructions about the mechanics of submitting, not something drafted or
  // confirmed — "how to apply" is read, not written. Kept out of both
  // `writable` (nothing to compose) and `conditions` (nothing to check off).
  const process = (requirements ?? []).filter((r) => r.kind === "process");
  const drafted = writable.filter((r) => sections[r.id]?.content).length;

  return (
    <>
      <main className="mx-auto max-w-3xl px-6 py-12 print:hidden">
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

        {/* What this actually is, before anything about how to apply for it —
          in the funder's own words, already sitting in the catalog from
          ingestion. Reading it required opening "The call itself" until now,
          which is exactly the kind of thing this app should never make a
          consultant leave it to go find out. */}
        {error && !grant && (
          <p role="alert" className="mt-4 text-sm text-[var(--color-ineligible)]">
            {error}
          </p>
        )}
        {grant && <CallSnapshot grant={grant} />}
        {submission && (
          <p
            data-testid="submitted-lock"
            className="mt-4 rounded-md border border-[var(--color-rule)] bg-[var(--color-accent-soft)] p-3 text-sm"
          >
            Submitted on {new Date(submission.submitted_at).toLocaleDateString()}. The application
            is locked so the record matches what the funder received.
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={readCall}
            disabled={busy !== null}
            data-testid="read-call"
            className="rounded-md bg-[var(--color-accent-strong)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
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

        {/* A second, independent pass's remaining doubts about the read above —
          not a rule this app is refusing to state, a genuine "go check this"
          from a critic that read the same pages with no memory of having
          produced the extraction it is reviewing. Shown plainly rather than
          resolved automatically: a third round chasing one concern on the
          same two pages would rarely find more than a person can in ten
          seconds by looking. */}
        {concerns.length > 0 && (
          <section className="mt-6" data-testid="extraction-concerns">
            <h2 className="text-sm font-semibold text-[var(--color-needs-input)]">
              Worth double-checking
            </h2>
            <ul className="mt-2 flex flex-col gap-1 text-sm text-[var(--color-ink-soft)]">
              {concerns.map((concern, index) => (
                <li key={index}>• {concern}</li>
              ))}
            </ul>
          </section>
        )}

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
                            <span className="text-[var(--color-ink-soft)]">
                              {" "}
                              · {award.location}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--color-ink-soft)]">
                          {/* USAspending reports federal awards in US dollars. */}
                          {award.amount ? formatMoney(Math.round(award.amount), "USD") : "—"}
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
        {error && grant && (
          <p role="alert" className="mt-3 text-sm text-[var(--color-ineligible)]">
            {error}
          </p>
        )}

        {/* What the read actually found, shown here rather than only at the
          source. A consultant should never have to leave the app to see
          material this system already fetched — the link to the call's own
          page stays above for when something in here needs double-checking,
          but reading happens here first.
          Shown whenever there is no section list to draft against, not only
          on a total miss: a call can name its conditions clearly and never
          publish a section list at all (most keep that in the application
          form or a PDF), which used to leave "Add a section" a blind guess
          even though the raw text was already sitting in readText. */}
        {readText && writable.length === 0 && (
          <section className="mt-8" data-testid="read-text">
            <h2 className="text-sm font-semibold">What we read from their page</h2>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              {requirements !== null && requirements.length > 0
                ? "No section list came out of this automatically — read it here and add the headings below."
                : "No structure came out of this automatically — read it here and add the headings below."}
            </p>
            <pre className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] p-4 text-sm">
              {readText}
            </pre>
          </section>
        )}

        {/* Read, not drafted. This used to be classified as a section and
          handed to the model, which duly wrote a paragraph elaborating on a
          one-sentence instruction — "contact your regional office and submit
          the form" restated in first person, with nothing in it a consultant
          couldn't already read here in ten seconds. */}
        {process.length > 0 && (
          <section className="mt-10" data-testid="process-steps">
            <h2 className="text-sm font-semibold">How this call is submitted</h2>
            <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
              {process.map((requirement) => (
                <li key={requirement.id} className="bg-[var(--color-surface)] px-4 py-3">
                  <span className="text-sm font-medium">{requirement.label}</span>
                  <p className="mt-1 text-sm">{requirement.source_quote ?? requirement.detail}</p>
                </li>
              ))}
            </ul>
          </section>
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
                    <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                      {requirement.detail}
                    </p>
                  )}
                  <AssignmentControls
                    label={requirement.label}
                    assignment={assignments[requirement.id]}
                    team={team}
                    locked={!!submission}
                    onChange={(patch) => assign(requirement, patch)}
                  />
                  {/* Read against this client's own profile, automatically — the
                    manual re-check this replaces. Still only a reading aid:
                    it names what matches and what the profile does not say,
                    never a verdict, and never ticks the box below itself. */}
                  {assessments[requirement.id] && (
                    <p
                      data-testid="condition-assessment"
                      className="mt-2 rounded-md bg-[var(--color-paper)] p-2 text-sm text-[var(--color-ink-soft)]"
                    >
                      {assessments[requirement.id]}
                    </p>
                  )}
                  {/* Software cannot verify that audited statements exist. What it
                    can do is refuse to call the application ready until a person
                    says they have them — and record who said so. */}
                  {requirement.is_critical && (
                    <>
                      <label className="mt-2 flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={acknowledged.has(requirement.id)}
                          onChange={(event) => acknowledge(requirement, event.target.checked)}
                          disabled={!!submission}
                        />
                        I have this
                      </label>
                      {requirement.kind === "attachment" &&
                        acknowledged.has(requirement.id) &&
                        registerDocs.length > 0 && (
                          <select
                            value={linked[requirement.id] ?? ""}
                            onChange={(event) => linkFromRegister(requirement, event.target.value)}
                            disabled={!!submission}
                            aria-label={`Use a document from the register for "${requirement.label}"`}
                            data-testid="use-from-register"
                            className="mt-2 w-full rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1 text-sm"
                          >
                            <option value="">Use from register…</option>
                            {registerDocs.map((doc) => (
                              <option key={doc.id} value={doc.id}>
                                {doc.title} ({KIND_LABEL[doc.kind]},{" "}
                                {documentStatus(doc, new Date())})
                              </option>
                            ))}
                          </select>
                        )}
                      {requirement.kind === "attachment" && acknowledged.has(requirement.id) && (
                        <input
                          // Remounted when a register document is picked, so the
                          // uncontrolled field shows the location it filled in.
                          key={linked[requirement.id] ?? "typed"}
                          type="text"
                          defaultValue={locations[requirement.id] ?? ""}
                          onBlur={(event) => saveLocation(requirement, event.target.value)}
                          disabled={!!submission}
                          placeholder="Where is it? A Drive link, a folder, who has it…"
                          aria-label={`Where to find "${requirement.label}"`}
                          className="mt-2 w-full rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1 text-sm"
                        />
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Reachable the moment a read has been attempted, whether it found
          anything or not — this used to require requirements.length > 0,
          which meant the one call that adds the first section (right below)
          could never render on a call nothing was extracted from. The
          consultant was told "add the headings below" on a page with no
          "below" to add them to: a dead end on exactly the calls where the
          form matters most, which the honest Business Benefits Finder listing
          this was found against is a real, common example of — its own URL
          is an administrator's page, not the opportunity's, so extraction
          has nothing to read there by design, not by failure. */}
        {grant && (
          <OpportunityBrief
            clientId={clientId}
            grantId={grantId}
            onGate={setGate}
            locked={!!submission}
            // The pre-fill reads the call's requirements; showing the form
            // before they arrive and swapping it afterwards would wipe typing.
            ready={requirements !== null && busy !== "read"}
            prefill={{
              deadline: grant.deadline,
              amountMax: grant.amount_max,
              amountMin: grant.amount_min,
              currency: grant.currency,
              // The same text the cost_share rule reads, so the budget and the
              // verdict agree about what the call requires.
              costShareText: [grant.eligibility_note, grant.summary].filter(Boolean).join(" "),
              mandatoryComponents: (requirements ?? [])
                .filter((r) => r.is_critical || r.kind === "attachment")
                .map((r) => `• ${r.label}${r.source_quote ? ` — "${r.source_quote}"` : ""}`)
                .join("\n"),
              risks: [
                grant.amount_max ? null : "The funder publishes no award amount.",
                grant.deadline ? null : "No closing date published — confirm intake timing.",
                grant.eligibility_note ? null : "No eligibility text published — read the guide.",
                (grant.documents ?? []).length
                  ? null
                  : "No application guide linked by the source.",
              ]
                .filter(Boolean)
                .join("\n"),
            }}
          />
        )}

        {requirements !== null && (
          <section className="mt-10">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">What they asked you to write</h2>
              {drafted > 0 && (
                <button
                  type="button"
                  onClick={() => window.print()}
                  data-testid="export-print"
                  className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs font-medium"
                >
                  Export as document
                </button>
              )}
            </div>

            {writable.length === 0 && (
              <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                {conditions.length > 0
                  ? "This call publishes its conditions but not its section list — most funders keep that in the application form or a PDF. Add the headings from the form and we will draft against them."
                  : "We could not read requirements from this call's own page — read it yourself below, then add the headings its form asks for and we will draft against them."}
              </p>
            )}

            <ul className="mt-3 flex flex-col gap-4">
              {writable.map((requirement) => (
                <SectionCard
                  key={requirement.id}
                  proposalId={proposalId!}
                  requirement={requirement}
                  section={sections[requirement.id]}
                  busy={busy === requirement.id}
                  disabled={busy !== null || !gate.allowed || !!submission}
                  locked={!!submission}
                  assignment={assignments[requirement.id]}
                  team={team}
                  onAssign={(patch) => assign(requirement, patch)}
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
                disabled={busy !== null || !!submission}
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
                  {new Date(submission.submitted_at).toLocaleDateString()} ·{" "}
                  {OUTCOME_LABEL[submission.outcome ?? "awaiting"] ?? submission.outcome}
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
                {submission.outcome === "awarded" && proposalId && (
                  <AwardPanel proposalId={proposalId} grantCurrency={grant?.currency ?? null} />
                )}
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
                      className="rounded-md bg-[var(--color-accent-strong)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
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

      {/* Print-only: assembled as a plain document rather than mirroring the
        editing UI — buttons, badges and "double-check" warnings mean nothing
        on a page headed for a funder's portal. window.print() on the export
        button above is the trigger; @media print in index.css hides
        everything but this block. */}
      {/* Hidden from assistive tech: on screen it would be a second H1 and a
          second copy of every section; it exists only for paper. */}
      <div aria-hidden="true" className="hidden print:block print:px-0 print:py-0">
        <h1 className="text-xl font-semibold">{grant?.title ?? "Application"}</h1>
        <p className="mt-1 text-sm">{grant?.deadline ? `Closes ${grant.deadline}` : ""}</p>
        {writable.map((requirement) => {
          const section = sections[requirement.id];
          if (!section?.content?.trim()) return null;
          return (
            <section key={requirement.id} className="mt-6 break-inside-avoid">
              <h2 className="text-base font-semibold">{requirement.label}</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{section.content}</p>
            </section>
          );
        })}
      </div>
    </>
  );
}

type Revision = {
  id: string;
  content: string;
  word_count: number | null;
  drafted_by: string | null;
  created_at: string;
};

function SectionCard({
  proposalId,
  requirement,
  section,
  busy,
  disabled,
  onDraft,
  onSave,
  onKeep,
  locked = false,
  assignment,
  team,
  onAssign,
}: {
  proposalId: string;
  assignment: Assignment | undefined;
  team: TeamMember[];
  onAssign: (patch: AssignmentPatch) => void;
  requirement: Requirement;
  section: Section | undefined;
  busy: boolean;
  disabled: boolean;
  /** Submitted: the text is the record of what was sent. */
  locked?: boolean;
  onDraft: () => void;
  onSave: (content: string) => Promise<boolean>;
  onKeep: (content: string) => void;
}) {
  const [text, setText] = useState(section?.content ?? "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  async function toggleHistory() {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    // Read on every open: a re-draft since the last look adds a version, and a
    // cached list would hide the one the consultant most likely wants back.
    const { data, error: historyError } = await supabase()
      .from("proposal_section_revisions")
      .select("id, content, word_count, drafted_by, created_at")
      .eq("proposal_id", proposalId)
      .eq("requirement_id", requirement.id)
      .order("created_at", { ascending: false })
      .limit(10);
    setRevisions(historyError ? null : ((data as Revision[] | null) ?? []));
    setShowHistory(true);
  }

  function restore(revision: Revision) {
    setText(revision.content);
    setDirty(true);
    setShowHistory(false);
  }

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

      <AssignmentControls
        label={requirement.label}
        assignment={assignment}
        team={team}
        locked={locked}
        onChange={onAssign}
      />
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
        readOnly={locked}
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
          onClick={() => {
            // A new draft replaces the text box; unsaved hand edits would
            // otherwise stay on screen over it and then be saved on top of it.
            if (dirty && !window.confirm("Replace your unsaved edits with a new draft?")) return;
            setDirty(false);
            onDraft();
          }}
          disabled={disabled || saving}
          className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Writing…" : section?.content ? "Draft again" : "Draft this"}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={async () => {
              // Clean only once the save is confirmed: marking it clean first
              // let a failed save swap the consultant's edit for the old text.
              setSaving(true);
              const saved = await onSave(text);
              setSaving(false);
              if (saved) setDirty(false);
            }}
            disabled={disabled || saving}
            className="rounded-md bg-[var(--color-accent-strong)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
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
        {section?.content && (
          <button
            type="button"
            onClick={toggleHistory}
            className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs"
          >
            {showHistory ? "Hide history" : "History"}
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

      {/* Said in words rather than left as a model name. "ollama/phi4-mini"
          means nothing to a consultant, and the difference it makes is real:
          the eval measured the fallback inventing figures where the hosted
          model did not. */}
      {section?.drafted_by?.startsWith("ollama") && (
        <p data-testid="fallback-warning" className="mt-2 text-sm text-[var(--color-needs-input)]">
          The usual models were unreachable, so this was written by the small local one. Read it
          closely before it goes anywhere, or draft it again now.
        </p>
      )}

      {/* Checked live now against everything the model was actually given —
          the client's profile, their reused answers, this call's own
          numbers — not only measured offline in tests/evals/drafting.eval.ts.
          A hit here means the draft states something nobody told it, which
          is exactly the thing a consultant cannot see by reading confident
          prose. */}
      {section && section.fabrication_concerns.length > 0 && (
        <div
          data-testid="fabrication-warning"
          className="mt-2 rounded-md border border-[var(--color-needs-input)] bg-[var(--color-needs-input)]/10 p-3 text-sm"
        >
          <p className="font-medium text-[var(--color-needs-input)]">
            Double-check before sending — this draft says things nobody gave it:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {section.fabrication_concerns.map((f, index) => (
              <li key={index}>
                {f.kind === "person" ? `Names someone unverified: "${f.text}"` : `"${f.text}"`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {showHistory && (
        <div
          data-testid="section-history"
          className="mt-3 rounded-md border border-[var(--color-rule)] p-3"
        >
          {revisions === null ? (
            <p className="text-sm text-[var(--color-ineligible)]">
              Could not load earlier versions. Close and open History to try again.
            </p>
          ) : revisions.length === 0 ? (
            <p className="text-sm text-[var(--color-ink-soft)]">
              No earlier version — this is the only one.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {revisions.map((revision) => (
                <li
                  key={revision.id}
                  className="flex items-start justify-between gap-3 border-t border-[var(--color-rule)] pt-2 first:border-t-0 first:pt-0"
                >
                  <div className="min-w-0">
                    <p className="text-xs text-[var(--color-ink-soft)]">
                      {new Date(revision.created_at).toLocaleString()}
                      {revision.word_count ? ` · ${revision.word_count} words` : ""}
                      {revision.drafted_by ? ` · ${revision.drafted_by}` : " · edited by hand"}
                    </p>
                    <p className="mt-1 truncate text-sm text-[var(--color-ink-soft)]">
                      {revision.content}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => restore(revision)}
                    className="shrink-0 rounded-md border border-[var(--color-rule)] px-2 py-1 text-xs"
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** Who on the client's team has this requirement, and the firm's own date for it. */
function AssignmentControls({
  label,
  assignment,
  team,
  locked,
  onChange,
}: {
  label: string;
  assignment: Assignment | undefined;
  team: TeamMember[];
  locked: boolean;
  onChange: (patch: AssignmentPatch) => void;
}) {
  const ownerId = assignment?.ownerId ?? "";
  // An owner who has since left the team still shows, named as such, rather
  // than the select silently reading "Unassigned" over a stored owner.
  const departed = ownerId !== "" && !team.some((m) => m.userId === ownerId);
  return (
    <div
      data-testid="assignment"
      className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-soft)]"
    >
      <select
        aria-label={`Owner of "${label}"`}
        value={ownerId}
        disabled={locked}
        onChange={(event) => onChange({ ownerId: event.target.value || null })}
        className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1"
      >
        <option value="">Unassigned</option>
        {departed && <option value={ownerId}>No longer on the team</option>}
        {team.map((m) => (
          <option key={m.userId} value={m.userId}>
            {memberName(m)}
            {m.isOwner ? " (client owner)" : ""}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1">
        Due
        <input
          type="date"
          aria-label={`Internal due date for "${label}"`}
          value={assignment?.dueOn ?? ""}
          disabled={locked}
          onChange={(event) => onChange({ dueOn: event.target.value || null })}
          className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1"
        />
      </label>
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          aria-label={`"${label}" is done`}
          checked={!!assignment?.doneAt}
          disabled={locked}
          onChange={(event) =>
            onChange({ doneAt: event.target.checked ? new Date().toISOString() : null })
          }
        />
        Done
      </label>
    </div>
  );
}
