import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Landing } from "@/components/Landing";
import { daysUntilDeadline } from "@/lib/deadline";
import { buildIcs } from "@/lib/ics";
import {
  calendarFeedPath,
  generateCalendarToken,
  hashCalendarToken,
  isInProgress,
} from "@/lib/calendar-feed";
import { useDocumentTitle } from "@/lib/use-document-title";

export const Route = createFileRoute("/")({ component: Home });

type Row = {
  id: string;
  client_id: string;
  grant_id: string;
  clients: { name: string } | null;
  grants: { title: string; deadline: string | null } | null;
  submissions: Array<{ submitted_at: string; outcome: string | null }>;
  proposal_sections: Array<{ id: string }>;
  /** Joined in code from opportunity_decisions. */
  decision?: string | null;
};

const DECISION_LABEL: Record<string, string> = {
  pending: "awaiting go / no-go",
  go: "GO",
  go_conditional: "GO-CONDITIONAL",
};

/** The same words the submission form uses, not the stored codes. */
const OUTCOME_LABEL: Record<string, string> = {
  awaiting: "Awaiting a decision",
  awarded: "Awarded",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

/**
 * The first of the five questions in docs/SPEC.md: what is due across all my
 * clients?
 *
 * This is the screen the whole product is shaped around. A consultant with
 * eight clients does not think in clients — they think in "what has to go out
 * this week", and every incumbent makes them open eight dashboards to find out.
 *
 * Sorted by what closes soonest, because that is the only ordering that
 * survives a Monday morning. Submitted applications drop to their own list
 * rather than disappearing: "did we send that?" is asked far more often than
 * it should have to be.
 */
function Home() {
  useDocumentTitle("What is due");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    const { data: session } = await supabase().auth.getSession();
    if (!session.session) {
      setSignedIn(false);
      return;
    }
    setSignedIn(true);

    const [proposals, decisions] = await Promise.all([
      supabase()
        .from("proposals")
        .select(
          "id, client_id, grant_id, clients(name), grants(title, deadline), " +
            "submissions(submitted_at, outcome), proposal_sections(id)",
        )
        .order("submitted_at", { referencedTable: "submissions", ascending: false }),
      supabase().from("opportunity_decisions").select("client_id, grant_id, decision"),
    ]);
    const readError = proposals.error ?? decisions.error;
    if (readError) {
      setError(readError.message);
      return;
    }
    const decisionOf = new Map(
      (
        (decisions.data ?? []) as Array<{ client_id: string; grant_id: string; decision: string }>
      ).map((d) => [`${d.client_id}|${d.grant_id}`, d.decision]),
    );
    setRows(
      ((proposals.data ?? []) as unknown as Row[]).map((r) => ({
        ...r,
        decision: decisionOf.get(`${r.client_id}|${r.grant_id}`) ?? null,
      })),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // In progress means real work exists — a section or a brief. Merely opening
  // a call to look at it is not an application, and a no-go is not due.
  const active = (rows ?? []).filter(isInProgress);
  const isClosed = (r: Row) =>
    !!r.grants?.deadline && daysUntilDeadline(r.grants.deadline, new Date()) < 0;
  const lapsed = active.filter(isClosed);
  const open = active
    .filter((r) => !isClosed(r))
    .sort((a, b) => {
      // A call with no published closing date is genuinely less urgent than one
      // that closes on Friday, so it sorts last rather than first.
      const left = a.grants?.deadline ?? "9999-12-31";
      const right = b.grants?.deadline ?? "9999-12-31";
      return left.localeCompare(right);
    });
  const sent = (rows ?? []).filter((r) => r.submissions.length > 0);

  // One route, two audiences. A visitor gets the case for the product; a
  // signed-in consultant gets the first of the five questions in docs/SPEC.md.
  // Splitting them into two routes would add a screen to the budget in
  // ADR-0002 for what is one address with two states.
  //
  // The landing is the default, not the else-branch. Reading the session is a
  // client-side call, so `signedIn` is null on the server — and asking for the
  // desk first meant this address served an empty document to every visitor
  // until JavaScript had run and answered. A landing page that arrives blank
  // is the first impression it exists to make.
  if (signedIn !== true) return <Landing />;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">What is due</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-ink-soft)]">
        Every application in progress, across every client, soonest first.
      </p>
      {open.some((r) => r.grants?.deadline) && (
        <button
          type="button"
          onClick={() => {
            const ics = buildIcs(
              open
                .filter((r) => r.grants?.deadline)
                .map((r) => ({
                  uid: r.id,
                  title: r.grants?.title ?? "Application",
                  client: r.clients?.name ?? "Client",
                  deadline: r.grants!.deadline!,
                  url: `${window.location.origin}/clients/${r.client_id}/proposals/${r.grant_id}`,
                  note: r.decision ? `Decision: ${DECISION_LABEL[r.decision] ?? r.decision}` : null,
                })),
            );
            const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "grantdesk-deadlines.ics";
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="mt-3 rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium"
        >
          Add these deadlines to my calendar (.ics)
        </button>
      )}
      <CalendarSubscription />

      {error && (
        <p role="alert" className="mt-4 text-sm text-[var(--color-ineligible)]">
          {error}
        </p>
      )}

      {signedIn &&
        rows !== null &&
        open.length === 0 &&
        sent.length === 0 &&
        lapsed.length === 0 && (
          <p className="mt-8 text-sm text-[var(--color-ink-soft)]">
            Nothing in progress yet.{" "}
            <Link to="/clients" className="text-[var(--color-accent)]">
              Add a client
            </Link>{" "}
            and find what they can apply for.
          </p>
        )}

      {open.length > 0 && (
        <ul
          data-testid="due-list"
          className="mt-6 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]"
        >
          {open.map((row) => (
            <li key={row.id} className="bg-[var(--color-surface)] px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <Link
                  to="/clients/$clientId/proposals/$grantId"
                  params={{ clientId: row.client_id, grantId: row.grant_id }}
                  className="font-medium text-[var(--color-accent)]"
                >
                  {row.grants?.title ?? "Application"}
                </Link>
                <Deadline date={row.grants?.deadline ?? null} />
              </div>
              <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                {row.clients?.name}
                {row.decision ? ` · ${DECISION_LABEL[row.decision] ?? row.decision}` : ""}
                {` · ${row.proposal_sections.length} section${row.proposal_sections.length === 1 ? "" : "s"} started`}
              </p>
            </li>
          ))}
        </ul>
      )}

      {lapsed.length > 0 && (
        <section className="mt-10" data-testid="lapsed-list">
          <h2 className="text-sm font-semibold">Closed before it was sent</h2>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            Work exists but the deadline has passed. Kept so the effort is not lost if it reopens.
          </p>
          <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
            {lapsed.map((row) => (
              <li key={row.id} className="bg-[var(--color-surface)] px-4 py-3 text-sm">
                <Link
                  to="/clients/$clientId/proposals/$grantId"
                  params={{ clientId: row.client_id, grantId: row.grant_id }}
                  className="text-[var(--color-accent)]"
                >
                  {row.grants?.title ?? "Application"}
                </Link>
                <span className="text-[var(--color-ink-soft)]">
                  {" "}
                  · {row.clients?.name} · closed {row.grants?.deadline}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sent.length > 0 && (
        <section className="mt-10" data-testid="sent-list">
          <h2 className="text-sm font-semibold">Sent</h2>
          {/* A win rate over "everything ever sent" answers a different
              question than a consultant actually asks — "awaiting" is not
              yet a result, and folding it in permanently understates a
              track record right after a busy month of submissions. Counted
              only over outcomes that have actually landed. */}
          {(() => {
            const decided = sent.filter(
              (r) =>
                r.submissions[0]?.outcome === "awarded" || r.submissions[0]?.outcome === "declined",
            );
            const awarded = decided.filter((r) => r.submissions[0]?.outcome === "awarded").length;
            const awaiting = sent.filter((r) => r.submissions[0]?.outcome === "awaiting").length;
            if (decided.length === 0) return null;
            return (
              <p data-testid="win-rate" className="mt-1 text-sm text-[var(--color-ink-soft)]">
                {awarded} of {decided.length} decided applications awarded (
                {Math.round((awarded / decided.length) * 100)}%)
                {awaiting > 0 ? ` · ${awaiting} still awaiting` : ""}.
              </p>
            );
          })()}
          <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
            {sent.map((row) => (
              <li
                key={row.id}
                className="flex items-baseline justify-between gap-3 bg-[var(--color-surface)] px-4 py-3"
              >
                <span className="text-sm">
                  {/* The outcome is recorded on the application itself. */}
                  <Link
                    to="/clients/$clientId/proposals/$grantId"
                    params={{ clientId: row.client_id, grantId: row.grant_id }}
                    className="text-[var(--color-accent)]"
                  >
                    {row.grants?.title ?? "Application"}
                  </Link>
                  <span className="text-[var(--color-ink-soft)]"> · {row.clients?.name}</span>
                </span>
                <span className="shrink-0 text-xs text-[var(--color-ink-soft)]">
                  {OUTCOME_LABEL[row.submissions[0]?.outcome ?? "awaiting"] ??
                    row.submissions[0]?.outcome}{" "}
                  · {new Date(row.submissions[0]!.submitted_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

type ActiveToken = { id: string; created_at: string };

/**
 * A feed the calendar app keeps polling, unlike the one-off download above,
 * which is out of date the first time a deadline moves. The raw link exists
 * only in this component's state: the database keeps its hash, so a lost link
 * is replaced, never recovered.
 */
function CalendarSubscription() {
  const [active, setActive] = useState<ActiveToken | null | undefined>(undefined);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data, error: readError } = await supabase()
        .from("calendar_tokens")
        .select("id, created_at")
        .is("revoked_at", null)
        .order("created_at", { ascending: false })
        .limit(1);
      if (readError) setError(`Could not read your calendar link: ${readError.message}`);
      else setActive((data?.[0] as ActiveToken | undefined) ?? null);
    })();
  }, []);

  const revokeAll = async () => {
    const { error: revokeError } = await supabase()
      .from("calendar_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .is("revoked_at", null);
    if (revokeError) throw new Error(revokeError.message);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data: session } = await supabase().auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) throw new Error("Your session expired. Sign in again.");
      // One live link per consultant: a new one retires the old.
      await revokeAll();
      const token = generateCalendarToken();
      const { data, error: insertError } = await supabase()
        .from("calendar_tokens")
        .insert({ consultant_id: userId, token_hash: await hashCalendarToken(token) })
        .select("id, created_at")
        .single();
      if (insertError) throw new Error(insertError.message);
      setActive(data as ActiveToken);
      setFreshUrl(`${window.location.origin}${calendarFeedPath(token)}`);
    } catch (caught) {
      setError(
        `Could not create a calendar link: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await revokeAll();
      setActive(null);
      setFreshUrl(null);
    } catch (caught) {
      setError(
        `Could not revoke the calendar link: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const buttonClass =
    "rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium disabled:opacity-50";

  return (
    <section data-testid="calendar-subscription" className="mt-3 text-sm">
      {active === null && (
        <button type="button" disabled={busy} onClick={() => void create()} className={buttonClass}>
          Subscribe in Google/Outlook
        </button>
      )}
      {freshUrl && (
        <div className="mt-2 rounded-md border border-[var(--color-rule)] p-3">
          <p>
            Add this address in Google Calendar (Other calendars, From URL) or Outlook (Add
            calendar, Subscribe from web). It is shown only now; anyone with it can see these
            deadlines.
          </p>
          <input
            readOnly
            value={freshUrl}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Calendar subscription address"
            className="mt-2 w-full rounded border border-[var(--color-rule)] px-2 py-1 font-mono text-xs"
          />
        </div>
      )}
      {active && (
        <p className="mt-2 text-[var(--color-ink-soft)]">
          {freshUrl
            ? ""
            : `A calendar subscription is active since ${new Date(active.created_at).toLocaleDateString()}. Lost the address? Revoke it and subscribe again. `}
          <button
            type="button"
            disabled={busy}
            onClick={() => void revoke()}
            className="text-[var(--color-accent)] underline"
          >
            Revoke calendar link
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[var(--color-ineligible)]">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Days, not dates. "Closes 2026-09-02" makes a consultant do arithmetic; "6
 * days left" is the thing they were going to work out anyway.
 */
function Deadline({ date }: { date: string | null }) {
  if (!date) {
    return <span className="shrink-0 text-xs text-[var(--color-ink-soft)]">no closing date</span>;
  }
  const days = daysUntilDeadline(date, new Date());
  const tone =
    days < 0
      ? "text-[var(--color-ineligible)]"
      : days <= 14
        ? "text-[var(--color-needs-input)]"
        : "text-[var(--color-ink-soft)]";
  return (
    <span className={`shrink-0 text-xs font-medium tabular-nums ${tone}`}>
      {days < 0 ? `closed ${date}` : days === 0 ? "closes today" : `${days} days left`}
    </span>
  );
}
