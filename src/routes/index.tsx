import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Landing } from "@/components/Landing";
import { daysUntilDeadline } from "@/lib/deadline";
import { buildIcs } from "@/lib/ics";
import { useDocumentTitle } from "@/lib/use-document-title";
import { errorMessage } from "@/lib/error-message";
import { inRenewalWindow, REPORT_KIND_LABEL, type ReportKind } from "@/lib/post-award";

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

type ProposalRef = {
  client_id: string;
  grant_id: string;
  clients: { name: string } | null;
  grants: { title: string } | null;
};

type ReportRow = {
  id: string;
  label: string;
  kind: ReportKind;
  due_on: string;
  proposals: ProposalRef | null;
};

type AwardRow = { proposal_id: string; end_on: string | null; proposals: ProposalRef | null };

/** One line on the list: an application, a report owed, or a renewal window. */
type DueItem =
  | { type: "application"; date: string | null; row: Row }
  | { type: "report"; date: string; report: ReportRow }
  | { type: "renewal"; date: string; award: AwardRow };

const REF = "client_id, grant_id, clients(name), grants(title)";

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
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [awards, setAwards] = useState<AwardRow[]>([]);
  const [marking, setMarking] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: session } = await supabase().auth.getSession();
    if (!session.session) {
      setSignedIn(false);
      return;
    }
    setSignedIn(true);

    const [proposals, decisions, reportResult, awardResult] = await Promise.all([
      supabase()
        .from("proposals")
        .select(
          "id, client_id, grant_id, clients(name), grants(title, deadline), " +
            "submissions(submitted_at, outcome), proposal_sections(id)",
        )
        .order("submitted_at", { referencedTable: "submissions", ascending: false }),
      supabase().from("opportunity_decisions").select("client_id, grant_id, decision"),
      supabase()
        .from("award_reports")
        .select(`id, label, kind, due_on, proposals(${REF})`)
        .is("submitted_on", null)
        .order("due_on"),
      supabase()
        .from("award_details")
        .select(`proposal_id, end_on, proposals(${REF})`)
        .not("end_on", "is", null),
    ]);
    const readError = proposals.error ?? decisions.error ?? reportResult.error ?? awardResult.error;
    if (readError) {
      setError(readError.message);
      return;
    }
    const decisionOf = new Map(
      (
        (decisions.data ?? []) as Array<{ client_id: string; grant_id: string; decision: string }>
      ).map((d) => [`${d.client_id}|${d.grant_id}`, d.decision]),
    );
    setReports((reportResult.data ?? []) as unknown as ReportRow[]);
    setAwards((awardResult.data ?? []) as unknown as AwardRow[]);
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
  const active = (rows ?? []).filter(
    (r) =>
      r.submissions.length === 0 &&
      r.decision !== "no_go" &&
      (r.proposal_sections.length > 0 || r.decision != null),
  );
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

  const now = new Date();
  // An overdue report is still owed, so it stays on the list; a lapsed
  // application cannot be sent any more, which is why it has its own section.
  const items: DueItem[] = [
    ...open.map((row) => ({
      type: "application" as const,
      date: row.grants?.deadline ?? null,
      row,
    })),
    ...reports.map((report) => ({ type: "report" as const, date: report.due_on, report })),
    ...awards
      .filter((award) => inRenewalWindow(award.end_on, now))
      .map((award) => ({ type: "renewal" as const, date: award.end_on!, award })),
  ].sort((a, b) => (a.date ?? "9999-12-31").localeCompare(b.date ?? "9999-12-31"));

  async function markReportSubmitted(report: ReportRow) {
    setMarking(report.id);
    setError(null);
    const { error: updateError } = await supabase()
      .from("award_reports")
      .update({ submitted_on: new Date().toISOString().slice(0, 10) })
      .eq("id", report.id);
    setMarking(null);
    if (updateError) {
      setError(errorMessage(updateError));
      return;
    }
    setReports((current) => current.filter((r) => r.id !== report.id));
  }

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

      {error && (
        <p role="alert" className="mt-4 text-sm text-[var(--color-ineligible)]">
          {error}
        </p>
      )}

      {signedIn &&
        rows !== null &&
        items.length === 0 &&
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

      {items.length > 0 && (
        <ul
          data-testid="due-list"
          className="mt-6 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]"
        >
          {items.map((item) =>
            item.type === "application" ? (
              <li key={item.row.id} className="bg-[var(--color-surface)] px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <Link
                    to="/clients/$clientId/proposals/$grantId"
                    params={{ clientId: item.row.client_id, grantId: item.row.grant_id }}
                    className="font-medium text-[var(--color-accent)]"
                  >
                    {item.row.grants?.title ?? "Application"}
                  </Link>
                  <Deadline date={item.row.grants?.deadline ?? null} />
                </div>
                <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                  {item.row.clients?.name}
                  {item.row.decision
                    ? ` · ${DECISION_LABEL[item.row.decision] ?? item.row.decision}`
                    : ""}
                  {` · ${item.row.proposal_sections.length} section${item.row.proposal_sections.length === 1 ? "" : "s"} started`}
                </p>
              </li>
            ) : (
              <ObligationItem
                key={`${item.type}-${item.type === "report" ? item.report.id : item.award.proposal_id}`}
                item={item}
                busy={marking !== null}
                onSubmitted={markReportSubmitted}
              />
            ),
          )}
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

function ObligationItem({
  item,
  busy,
  onSubmitted,
}: {
  item: Exclude<DueItem, { type: "application" }>;
  busy: boolean;
  onSubmitted: (report: ReportRow) => void;
}) {
  const ref = item.type === "report" ? item.report.proposals : item.award.proposals;
  const days = daysUntilDeadline(item.date, new Date());
  const name = item.type === "report" ? item.report.label : (ref?.grants?.title ?? "Award");
  return (
    <li data-testid={`due-${item.type}`} className="bg-[var(--color-surface)] px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span>
          <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-needs-input)]">
            {item.type === "report" ? "Report due" : "Renewal window"}
          </span>
          {ref ? (
            <Link
              to="/clients/$clientId/proposals/$grantId"
              params={{ clientId: ref.client_id, grantId: ref.grant_id }}
              className="font-medium text-[var(--color-accent)]"
            >
              {name}
            </Link>
          ) : (
            <span className="font-medium">{name}</span>
          )}
        </span>
        <span
          className={`shrink-0 text-xs font-medium tabular-nums ${
            days < 0 ? "text-[var(--color-ineligible)]" : "text-[var(--color-ink-soft)]"
          }`}
        >
          {item.type === "renewal"
            ? `agreement ends in ${days} days`
            : days < 0
              ? `overdue since ${item.date}`
              : days === 0
                ? "due today"
                : `${days} days left`}
        </span>
      </div>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs text-[var(--color-ink-soft)]">
        <span>
          {ref?.clients?.name}
          {item.type === "report"
            ? ` · ${REPORT_KIND_LABEL[item.report.kind]} · ${ref?.grants?.title ?? ""}`
            : ` · ends ${item.date}; time to raise the renewal with the funder`}
        </span>
        {item.type === "report" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSubmitted(item.report)}
            data-testid="mark-report-submitted"
            className="text-[var(--color-accent)] disabled:opacity-50"
          >
            Mark as submitted
          </button>
        )}
      </p>
    </li>
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
