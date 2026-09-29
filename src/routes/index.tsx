import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Landing } from "@/components/Landing";
import { daysUntilDeadline } from "@/lib/deadline";
import { buildIcs } from "@/lib/ics";
import { useDocumentTitle } from "@/lib/use-document-title";
import { useI18n, type MessageKey } from "@/lib/i18n";

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

const DECISION_LABEL: Record<string, MessageKey> = {
  pending: "decision.pending",
  go: "decision.go",
  go_conditional: "decision.go_conditional",
};

/** The same words the submission form uses, not the stored codes. */
const OUTCOME_LABEL: Record<string, MessageKey> = {
  awaiting: "outcome.awaiting",
  awarded: "outcome.awarded",
  declined: "outcome.declined",
  withdrawn: "outcome.withdrawn",
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
  const { t, locale, language } = useI18n();
  useDocumentTitle(t("home.title"));
  const decisionLabel = (d: string) => {
    const key = DECISION_LABEL[d];
    return key ? t(key) : d;
  };
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
      <h1 className="text-2xl font-semibold tracking-tight">{t("home.title")}</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-ink-soft)]">{t("home.intro")}</p>
      {open.some((r) => r.grants?.deadline) && (
        <button
          type="button"
          onClick={() => {
            const ics = buildIcs(
              open
                .filter((r) => r.grants?.deadline)
                .map((r) => ({
                  uid: r.id,
                  title: r.grants?.title ?? t("home.application"),
                  client: r.clients?.name ?? t("home.client"),
                  deadline: r.grants!.deadline!,
                  url: `${window.location.origin}/clients/${r.client_id}/proposals/${r.grant_id}`,
                  note: r.decision
                    ? t("home.icsDecision", { decision: decisionLabel(r.decision) })
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
          className="mt-3 rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium"
        >
          {t("home.ics")}
        </button>
      )}

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
            {t("home.emptyBefore")}{" "}
            <Link to="/clients" className="text-[var(--color-accent)]">
              {t("home.emptyLink")}
            </Link>{" "}
            {t("home.emptyAfter")}
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
                  {row.grants?.title ?? t("home.application")}
                </Link>
                <Deadline date={row.grants?.deadline ?? null} />
              </div>
              <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                {row.clients?.name}
                {row.decision ? ` · ${decisionLabel(row.decision)}` : ""}
                {` · ${t(
                  row.proposal_sections.length === 1 ? "home.sectionsOne" : "home.sectionsOther",
                  { count: row.proposal_sections.length },
                )}`}
              </p>
            </li>
          ))}
        </ul>
      )}

      {lapsed.length > 0 && (
        <section className="mt-10" data-testid="lapsed-list">
          <h2 className="text-sm font-semibold">{t("home.lapsedTitle")}</h2>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{t("home.lapsedIntro")}</p>
          <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
            {lapsed.map((row) => (
              <li key={row.id} className="bg-[var(--color-surface)] px-4 py-3 text-sm">
                <Link
                  to="/clients/$clientId/proposals/$grantId"
                  params={{ clientId: row.client_id, grantId: row.grant_id }}
                  className="text-[var(--color-accent)]"
                >
                  {row.grants?.title ?? t("home.application")}
                </Link>
                <span className="text-[var(--color-ink-soft)]">
                  {" "}
                  · {row.clients?.name} · {t("home.closedOn", { date: row.grants?.deadline ?? "" })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sent.length > 0 && (
        <section className="mt-10" data-testid="sent-list">
          <h2 className="text-sm font-semibold">{t("home.sentTitle")}</h2>
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
                {t("home.winRate", {
                  awarded,
                  decided: decided.length,
                  percent: Math.round((awarded / decided.length) * 100),
                })}
                {awaiting > 0 ? t("home.stillAwaiting", { count: awaiting }) : ""}.
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
                    {row.grants?.title ?? t("home.application")}
                  </Link>
                  <span className="text-[var(--color-ink-soft)]"> · {row.clients?.name}</span>
                </span>
                <span className="shrink-0 text-xs text-[var(--color-ink-soft)]">
                  {(() => {
                    const outcome = row.submissions[0]?.outcome ?? "awaiting";
                    const key = OUTCOME_LABEL[outcome];
                    return key ? t(key) : outcome;
                  })()}{" "}
                  ·{" "}
                  {new Date(row.submissions[0]!.submitted_at).toLocaleDateString(
                    language === "en" ? undefined : locale,
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/**
 * Days, not dates. "Closes 2026-09-02" makes a consultant do arithmetic; "6
 * days left" is the thing they were going to work out anyway.
 */
function Deadline({ date }: { date: string | null }) {
  const { t } = useI18n();
  if (!date) {
    return (
      <span className="shrink-0 text-xs text-[var(--color-ink-soft)]">{t("home.noDate")}</span>
    );
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
      {days < 0
        ? t("home.closedOn", { date })
        : days === 0
          ? t("home.closesToday")
          : t("home.daysLeft", { count: days })}
    </span>
  );
}
