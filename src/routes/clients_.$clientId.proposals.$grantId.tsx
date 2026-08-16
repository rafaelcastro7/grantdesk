import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { errorMessage } from "@/lib/error-message";
import {
  draftProposalSection,
  readRequirements,
  saveToAnswerLibrary,
} from "@/server/proposal.functions";

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

  const [grant, setGrant] = useState<{
    title: string;
    url: string;
    deadline: string | null;
  } | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<Requirement[] | null>(null);
  const [sections, setSections] = useState<Record<string, Section>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const token = useCallback(async () => {
    const { data } = await supabase().auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new Error("Your session expired. Sign in again.");
    return accessToken;
  }, []);

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
  }, [clientId, grantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function readCall() {
    setBusy("read");
    setError(null);
    setNote(null);
    try {
      const result = await runRead({ data: { grantId, accessToken: await token() } });
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

  async function draft(requirement: Requirement) {
    if (!proposalId) return;
    setBusy(requirement.id);
    setError(null);
    setNote(null);
    try {
      const result = await runDraft({
        data: { clientId, proposalId, requirementId: requirement.id, accessToken: await token() },
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
          accessToken: await token(),
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
        {writable.length > 0 && (
          <span data-testid="draft-progress" className="text-sm text-[var(--color-ink-soft)]">
            {drafted} of {writable.length} sections drafted
          </span>
        )}
      </div>

      {note && <p className="mt-3 text-sm text-[var(--color-ink-soft)]">{note}</p>}
      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--color-ineligible)]">
          {error}
        </p>
      )}

      {requirements !== null && requirements.length === 0 && (
        <p className="mt-8 text-sm text-[var(--color-ink-soft)]">
          We have not read this call yet. Reading it lists what the funder actually asks for, so the
          draft answers their questions rather than a generic outline.
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
