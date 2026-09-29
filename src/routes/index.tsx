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
import {
  dueGroup,
  memberName,
  nextAssignment,
  toCsv,
  type Assignment,
  type DueGroup,
} from "@/lib/assignments";
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
  approver?: string | null;
  reason?: string | null;
  /** Joined in code from requirement_assignments. */
  assignments: Assignment[];
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
  no_go: "NO-GO",
};

/** The same words the submission form uses, not the stored codes. */
const OUTCOME_LABEL: Record<string, string> = {
  awaiting: "Awaiting a decision",
  awarded: "Awarded",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

const GROUPS: ReadonlyArray<readonly [Exclude<DueGroup, "closed">, string]> = [
  ["overdue", "Overdue"],
  ["this_week", "This week"],
  ["later", "Later"],
];

/**
 * The first of the five questions in docs/SPEC.md: what is due across all my
 * clients?
 *
 * This is the screen the whole product is shaped around. A consultant with
 * eight clients does not think in clients — they think in "what has to go out
 * this week", and every incumbent makes them open eight dashboards to find out.
 *
 * Grouped by urgency, where urgency counts the firm's own internal dates as
 * well as the funder's: a section due to the partner yesterday is overdue
 * whatever the call's deadline says. Submitted applications drop to their own
 * list rather than disappearing: "did we send that?" is asked far more often
 * than it should have to be.
 */
function Home() {
  useDocumentTitle("What is due");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [myId, setMyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [clientFilter, setClientFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
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
    setMyId(session.session.user.id);

    const [proposals, decisions, assignments, roster, reportResult, awardResult] = await Promise.all([
      supabase()
        .from("proposals")
        .select(
          "id, client_id, grant_id, clients(name), grants(title, deadline), " +
            "submissions(submitted_at, outcome), proposal_sections(id)",
        )
        .order("submitted_at", { referencedTable: "submissions", ascending: false }),
      supabase()
        .from("opportunity_decisions")
        .select(
          "client_id, grant_id, decision, decided_by, decision_reason, recommendation_reason",
        ),
      supabase()
        .from("requirement_assignments")
        .select("proposal_id, requirement_id, owner_id, due_on, done_at"),
      supabase().rpc("client_team_roster", { target: null }),
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
    // An owner filter over a failed assignment read would show "nothing due"
    // for someone with a full week; say it failed instead.
    const readError =
      proposals.error ??
      decisions.error ??
      assignments.error ??
      roster.error ??
      reportResult.error ??
      awardResult.error;
    if (readError) {
      setError(readError.message);
      return;
    }
    const decisionOf = new Map(
      (
        (decisions.data ?? []) as Array<{
          client_id: string;
          grant_id: string;
          decision: string;
          decided_by: string | null;
          decision_reason: string | null;
          recommendation_reason: string | null;
        }>
      ).map((d) => [`${d.client_id}|${d.grant_id}`, d]),
    );
    const assignmentsOf = new Map<string, Assignment[]>();
    for (const a of (assignments.data ?? []) as Array<{
      proposal_id: string;
      requirement_id: string;
      owner_id: string | null;
      due_on: string | null;
      done_at: string | null;
    }>) {
      const list = assignmentsOf.get(a.proposal_id) ?? [];
      list.push({
        requirementId: a.requirement_id,
        ownerId: a.owner_id,
        dueOn: a.due_on,
        doneAt: a.done_at,
      });
      assignmentsOf.set(a.proposal_id, list);
    }
    setNames(
      new Map(
        (
          (roster.data ?? []) as Array<{
            user_id: string;
            email: string;
            display_name: string | null;
          }>
        ).map((m) => [m.user_id, memberName({ email: m.email, displayName: m.display_name })]),
      ),
    );
    setReports((reportResult.data ?? []) as unknown as ReportRow[]);
    setAwards((awardResult.data ?? []) as unknown as AwardRow[]);
    setRows(
      ((proposals.data ?? []) as unknown as Row[]).map((r) => {
        const d = decisionOf.get(`${r.client_id}|${r.grant_id}`);
        return {
          ...r,
          decision: d?.decision ?? null,
          approver: d?.decided_by ?? null,
          reason: d?.decision_reason ?? d?.recommendation_reason ?? null,
          assignments: assignmentsOf.get(r.id) ?? [],
        };
      }),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const today = new Date();
  const owner = ownerFilter || null;
  const nameOf = (id: string | null) =>
    id ? (names.get(id) ?? "someone no longer on the team") : null;

  // In progress means real work exists — a section, a brief or an owner.
  // Merely opening a call to look at it is not an application, and a no-go
  // is not due.
  const active = (rows ?? []).filter(isInProgress);
  const shown = active.filter(
    (r) =>
      (!clientFilter || r.client_id === clientFilter) &&
      (!owner || r.assignments.some((a) => a.ownerId === owner && !a.doneAt)),
  );
  const grouped: Record<DueGroup, Row[]> = { overdue: [], this_week: [], later: [], closed: [] };
  for (const r of shown) {
    const next = nextAssignment(r.assignments, owner);
    grouped[dueGroup(r.grants?.deadline ?? null, next?.dueOn ?? null, today)].push(r);
  }
  // A call with no published closing date is genuinely less urgent than one
  // that closes on Friday, so it sorts last rather than first.
  const soonest = (r: Row) => {
    const next = nextAssignment(r.assignments, owner)?.dueOn ?? "9999-12-31";
    const deadline = r.grants?.deadline ?? "9999-12-31";
    return next < deadline ? next : deadline;
  };
  for (const key of Object.keys(grouped) as DueGroup[]) {
    grouped[key].sort((a, b) => soonest(a).localeCompare(soonest(b)));
  }
  const open = [...grouped.overdue, ...grouped.this_week, ...grouped.later];
  const lapsed = grouped.closed;
  const sent = (rows ?? []).filter(
    (r) => r.submissions.length > 0 && (!clientFilter || r.client_id === clientFilter),
  );

  const clients = [
    ...new Map((rows ?? []).map((r) => [r.client_id, r.clients?.name ?? "Client"])).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const owners = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));

  function exportCsv() {
    const status = (r: Row) => {
      if (r.submissions.length > 0) return "Sent";
      if (r.decision === "no_go") return "No-go";
      const next = nextAssignment(r.assignments);
      const group = dueGroup(r.grants?.deadline ?? null, next?.dueOn ?? null, today);
      return group === "closed"
        ? "Closed before sent"
        : (GROUPS.find(([k]) => k === group)?.[1] ?? group);
    };
    // Every application this consultant can see, whatever is filtered on
    // screen: the export is the firm's record, not the current view.
    const csv = toCsv([
      [
        "Client",
        "Call",
        "Deadline",
        "Status",
        "Decision",
        "Approved by",
        "Reason",
        "Next owner",
        "Next internal due",
        "Submitted",
        "Outcome",
      ],
      ...(rows ?? []).map((r) => {
        const next = nextAssignment(r.assignments);
        return [
          r.clients?.name,
          r.grants?.title,
          r.grants?.deadline,
          status(r),
          r.decision ? (DECISION_LABEL[r.decision] ?? r.decision) : "No brief yet",
          r.approver,
          r.reason,
          nameOf(next?.ownerId ?? null),
          next?.dueOn,
          r.submissions[0]?.submitted_at.slice(0, 10),
          r.submissions[0]?.outcome,
        ];
      }),
    ]);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "grantdesk-applications.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // Reports owed and renewal windows sit in the same urgency groups as the
  // applications. They carry no owner, so an owner filter hides them; an
  // overdue report is still owed, so it stays on the list, while a lapsed
  // application cannot be sent any more, which is why it has its own section.
  const obligations: Array<Exclude<DueItem, { type: "application" }>> = [
    ...reports.map((report) => ({ type: "report" as const, date: report.due_on, report })),
    ...awards
      .filter((award) => inRenewalWindow(award.end_on, today))
      .map((award) => ({ type: "renewal" as const, date: award.end_on!, award })),
  ];
  const shownObligations = obligations.filter((item) => {
    const ref = item.type === "report" ? item.report.proposals : item.award.proposals;
    return !owner && (!clientFilter || ref?.client_id === clientFilter);
  });
  const groupedItems: Record<Exclude<DueGroup, "closed">, DueItem[]> = {
    overdue: grouped.overdue.map((row) => ({ type: "application" as const, date: soonest(row), row })),
    this_week: grouped.this_week.map((row) => ({
      type: "application" as const,
      date: soonest(row),
      row,
    })),
    later: grouped.later.map((row) => ({ type: "application" as const, date: soonest(row), row })),
  };
  for (const item of shownObligations) {
    const group = dueGroup(null, item.date, today);
    groupedItems[group === "closed" ? "overdue" : group].push(item);
  }
  for (const key of Object.keys(groupedItems) as Array<Exclude<DueGroup, "closed">>) {
    groupedItems[key].sort((a, b) => (a.date ?? "9999-12-31").localeCompare(b.date ?? "9999-12-31"));
  }
  const items = [...groupedItems.overdue, ...groupedItems.this_week, ...groupedItems.later];

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

  const selectClass =
    "rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1 text-sm";

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">What is due</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-ink-soft)]">
        Every application in progress, across every client, by what needs doing soonest — the
        funder's deadline or your team's own due date, whichever comes first.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
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
                    note: r.decision
                      ? `Decision: ${DECISION_LABEL[r.decision] ?? r.decision}`
                      : null,
                  })),
              );
              const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
              const a = document.createElement("a");
              a.href = url;
              a.download = "grantdesk-deadlines.ics";
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium"
          >
            Add these deadlines to my calendar (.ics)
          </button>
        )}
        {(rows ?? []).length > 0 && (
          <button
            type="button"
            onClick={exportCsv}
            data-testid="export-applications"
            className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium"
          >
            Export all applications (CSV)
          </button>
        )}
      </div>
      <CalendarSubscription />

      {error && (
        <p role="alert" className="mt-4 text-sm text-[var(--color-ineligible)]">
          {error}
        </p>
      )}

      {(active.length > 0 || obligations.length > 0) && (
        <div
          className="mt-6 flex flex-wrap items-center gap-3 text-sm"
          role="group"
          aria-label="Filter what is due"
        >
          <label className="flex items-center gap-2">
            Client
            <select
              value={clientFilter}
              onChange={(e) => setClientFilter(e.target.value)}
              className={selectClass}
            >
              <option value="">All clients</option>
              {clients.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            Owner
            <select
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              className={selectClass}
            >
              <option value="">Anyone</option>
              {owners.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {myId && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={ownerFilter === myId}
                onChange={(e) => setOwnerFilter(e.target.checked ? myId : "")}
              />
              Only mine
            </label>
          )}
        </div>
      )}

      {signedIn &&
        rows !== null &&
        active.length === 0 &&
        obligations.length === 0 &&
        sent.length === 0 && (
        <p className="mt-8 text-sm text-[var(--color-ink-soft)]">
          Nothing in progress yet.{" "}
          <Link to="/clients" className="text-[var(--color-accent)]">
            Add a client
          </Link>{" "}
          and find what they can apply for.
        </p>
      )}

      {(active.length > 0 || obligations.length > 0) &&
        items.length === 0 &&
        lapsed.length === 0 && (
        <p className="mt-6 text-sm text-[var(--color-ink-soft)]">
          Nothing in progress matches these filters.
        </p>
      )}

      {items.length > 0 && (
        <div data-testid="due-list" className="mt-6 flex flex-col gap-6">
          {GROUPS.filter(([key]) => groupedItems[key].length > 0).map(([key, title]) => (
            <section key={key} data-testid={`due-${key}`}>
              <h2
                className={`text-sm font-semibold ${key === "overdue" ? "text-[var(--color-ineligible)]" : ""}`}
              >
                {title} ({groupedItems[key].length})
              </h2>
              <ul className="mt-2 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
                {groupedItems[key].map((item) => {
                  if (item.type !== "application") {
                    return (
                      <ObligationItem
                        key={`${item.type}-${item.type === "report" ? item.report.id : item.award.proposal_id}`}
                        item={item}
                        busy={marking !== null}
                        onSubmitted={markReportSubmitted}
                      />
                    );
                  }
                  const row = item.row;
                  const next = nextAssignment(row.assignments, owner);
                  return (
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
                      <p data-testid="next-due" className="mt-1 text-xs">
                        {next
                          ? `Next internal due ${next.dueOn} · ${nameOf(next.ownerId) ?? "no owner"}`
                          : "No internal due date set"}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {lapsed.length > 0 && (
        <section className="mt-10" data-testid="lapsed-list">
          <h2 className="text-sm font-semibold">Closed before it was sent ({lapsed.length})</h2>
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
