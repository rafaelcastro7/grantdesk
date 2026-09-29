import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { toCsv } from "@/lib/assignments";

type Decision = "pending" | "go" | "no_go" | "go_conditional";

type Entry = {
  grantId: string;
  title: string;
  funder: string | null;
  deadline: string | null;
  amountMax: number | null;
  currency: string | null;
  decision: Decision | "none";
  decidedBy: string | null;
  reason: string | null;
  decidedAt: string | null;
  submittedAt: string | null;
  outcome: string | null;
};

type GrantJoin = {
  title: string;
  deadline: string | null;
  amount_max: number | null;
  currency: string | null;
  funders: { name: string } | null;
} | null;

const LABEL: Record<Entry["decision"], string> = {
  none: "No brief yet",
  pending: "Awaiting decision",
  go: "GO",
  no_go: "NO-GO",
  go_conditional: "GO-CONDITIONAL",
};

const TONE: Record<Entry["decision"], string> = {
  none: "text-[var(--color-ink-soft)]",
  pending: "text-[var(--color-needs-input)]",
  go: "text-[var(--color-eligible)]",
  go_conditional: "text-[var(--color-needs-input)]",
  no_go: "text-[var(--color-ineligible)]",
};

type Filter = "all" | "open" | "go" | "no_go" | "submitted";

/**
 * Every call this client has opened or decided on, no-goes included.
 *
 * The SOP keeps this log because programs reopen and capabilities grow: a
 * no-go today is a candidate next cycle, and only a kept record says why it
 * was turned down. Built from real rows only — an empty log says it is empty.
 */
export function PipelineLog({ clientId }: { clientId: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const grantCols = "title, deadline, amount_max, currency, funders(name)";
      const [proposals, decisions] = await Promise.all([
        supabase()
          .from("proposals")
          .select(
            `grant_id, grants(${grantCols}), submissions(submitted_at, outcome), proposal_sections(id)`,
          )
          .eq("client_id", clientId)
          .order("submitted_at", { referencedTable: "submissions", ascending: false }),
        supabase()
          .from("opportunity_decisions")
          .select(
            `grant_id, decision, decided_by, decision_reason, recommendation_reason, decided_at, grants(${grantCols})`,
          )
          .eq("client_id", clientId),
      ]);
      if (cancelled) return;
      const error = proposals.error ?? decisions.error;
      if (error) {
        setFailure(error.message);
        return;
      }

      const byGrant = new Map<string, Entry>();
      const base = (grantId: string, g: GrantJoin): Entry => ({
        grantId,
        title: g?.title ?? "Call details unavailable",
        funder: g?.funders?.name ?? null,
        deadline: g?.deadline ?? null,
        amountMax: g?.amount_max ?? null,
        currency: g?.currency ?? null,
        decision: "none",
        decidedBy: null,
        reason: null,
        decidedAt: null,
        submittedAt: null,
        outcome: null,
      });

      for (const row of (proposals.data ?? []) as unknown as Array<{
        grant_id: string;
        grants: GrantJoin;
        submissions:
          | { submitted_at: string; outcome: string | null }
          | Array<{ submitted_at: string; outcome: string | null }>
          | null;
        proposal_sections: Array<{ id: string }>;
      }>) {
        const sent = Array.isArray(row.submissions) ? row.submissions[0] : row.submissions;
        // Opening a call is not logging it; only real work or a decision is.
        if (!sent && (row.proposal_sections ?? []).length === 0) continue;
        const entry = base(row.grant_id, row.grants);
        entry.submittedAt = sent?.submitted_at ?? null;
        entry.outcome = sent?.outcome ?? null;
        byGrant.set(row.grant_id, entry);
      }
      for (const row of (decisions.data ?? []) as unknown as Array<{
        grant_id: string;
        decision: Decision;
        decided_by: string | null;
        decision_reason: string | null;
        recommendation_reason: string | null;
        decided_at: string | null;
        grants: GrantJoin;
      }>) {
        const entry = byGrant.get(row.grant_id) ?? base(row.grant_id, row.grants);
        entry.decision = row.decision;
        entry.decidedBy = row.decided_by;
        entry.reason = row.decision_reason ?? row.recommendation_reason;
        entry.decidedAt = row.decided_at;
        byGrant.set(row.grant_id, entry);
      }

      setEntries(
        [...byGrant.values()].sort((a, b) =>
          (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const shown = useMemo(
    () =>
      (entries ?? []).filter((e) => {
        if (filter === "all") return true;
        if (filter === "submitted") return !!e.submittedAt;
        if (filter === "go") return e.decision === "go" || e.decision === "go_conditional";
        if (filter === "no_go") return e.decision === "no_go";
        return !e.submittedAt && (e.decision === "none" || e.decision === "pending");
      }),
    [entries, filter],
  );

  function exportCsv() {
    const header = [
      "Call",
      "Funder",
      "Deadline",
      "Max amount",
      "Currency",
      "Decision",
      "Decided by",
      "Decided on",
      "Reason",
      "Submitted",
      "Outcome",
    ];
    const csv = toCsv([
      header,
      ...shown.map((e) => [
        e.title,
        e.funder,
        e.deadline,
        e.amountMax,
        e.currency,
        LABEL[e.decision],
        e.decidedBy,
        e.decidedAt?.slice(0, 10),
        e.reason,
        e.submittedAt?.slice(0, 10),
        e.outcome,
      ]),
    ]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pipeline-log.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const counts = {
    all: entries?.length ?? 0,
    open: (entries ?? []).filter(
      (e) => !e.submittedAt && (e.decision === "none" || e.decision === "pending"),
    ).length,
    go: (entries ?? []).filter((e) => e.decision === "go" || e.decision === "go_conditional")
      .length,
    no_go: (entries ?? []).filter((e) => e.decision === "no_go").length,
    submitted: (entries ?? []).filter((e) => !!e.submittedAt).length,
  };

  return (
    <section className="mt-10" data-testid="pipeline-log">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Pipeline log</h2>
        {shown.length > 0 && (
          <button
            type="button"
            onClick={exportCsv}
            className="rounded-md border border-[var(--color-rule)] px-3 py-1 text-xs font-medium"
          >
            Export CSV
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
        Every call opened or decided for this client — no-goes are kept, with who decided and why.
      </p>

      {failure && (
        <p role="alert" className="mt-3 text-sm text-[var(--color-ineligible)]">
          {failure}
        </p>
      )}

      {entries !== null && entries.length === 0 && (
        <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
          Nothing logged yet. A call is logged once its Opportunity Brief is saved or a section is
          drafted.
        </p>
      )}

      {entries !== null && entries.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filter the log">
            {(
              [
                ["all", "All"],
                ["open", "Awaiting decision"],
                ["go", "Go"],
                ["no_go", "No-go"],
                ["submitted", "Submitted"],
              ] as const
            ).map(([key, text]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  filter === key
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-strong)] text-white"
                    : "border-[var(--color-rule)]"
                }`}
              >
                {text} ({counts[key]})
              </button>
            ))}
          </div>
          <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
            {shown.map((e) => (
              <li key={e.grantId} className="bg-[var(--color-surface)] px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link
                    to="/clients/$clientId/proposals/$grantId"
                    params={{ clientId, grantId: e.grantId }}
                    className="text-sm font-medium text-[var(--color-accent)]"
                  >
                    {e.title}
                  </Link>
                  <span
                    className={`text-xs font-semibold uppercase ${
                      e.submittedAt ? "text-[var(--color-eligible)]" : TONE[e.decision]
                    }`}
                  >
                    {e.submittedAt
                      ? `Submitted ${e.submittedAt.slice(0, 10)}${e.outcome ? ` · ${e.outcome}` : ""}`
                      : LABEL[e.decision]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                  {[
                    e.funder,
                    e.deadline ? `closes ${e.deadline}` : "rolling / no deadline",
                    e.amountMax
                      ? `up to ${e.currency ?? ""} ${e.amountMax.toLocaleString()}`
                      : null,
                    e.decidedBy ? `decided by ${e.decidedBy}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {e.reason && <p className="mt-1 text-sm">{e.reason}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
