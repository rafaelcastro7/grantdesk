import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { accessToken } from "@/lib/session";
import { errorMessage } from "@/lib/error-message";
import { findMatches } from "@/server/match.functions";

export const Route = createFileRoute("/clients_/$clientId/matches")({ component: MatchesPage });

type Verdict = "eligible" | "needs_input" | "ineligible";

type MatchRow = {
  id: string;
  verdict: Verdict;
  relevance: number | null;
  retrieval: { lexicalRank?: number | null; vectorRank?: number | null } | null;
  grants: {
    id: string;
    title: string;
    summary: string | null;
    url: string;
    country: string;
    currency: string | null;
    amount_min: number | null;
    amount_max: number | null;
    deadline: string | null;
    funders: { name: string } | null;
  } | null;
  eligibility_checks: Array<{
    rule_key: string;
    status: "pass" | "fail" | "unknown";
    is_hard_gate: boolean;
    detail: string;
  }>;
};

/**
 * The results screen.
 *
 * Three groups, in the order a consultant needs them: what they can apply for,
 * what is blocked on a question only they can answer, and what was ruled out.
 * The last group is collapsed but never dropped — a result that silently
 * disappears is indistinguishable from one we never found, and the difference
 * is the entire claim this product makes.
 */
const GROUPS: Array<{ verdict: Verdict; heading: string; blurb: string }> = [
  {
    verdict: "eligible",
    heading: "Can apply",
    blurb: "Every published requirement we can check is met.",
  },
  {
    verdict: "needs_input",
    heading: "Needs an answer from you",
    blurb: "One fact about this client decides it. Fill it in and these resolve.",
  },
  {
    verdict: "ineligible",
    heading: "Ruled out",
    blurb: "Considered and rejected, with the rule that rejected each one.",
  },
];

function MatchesPage() {
  const { clientId } = Route.useParams();
  const runMatching = useServerFn(findMatches);

  const [clientName, setClientName] = useState<string>("");
  const [matches, setMatches] = useState<MatchRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showRuledOut, setShowRuledOut] = useState(false);
  const autoRan = useRef(false);

  const load = useCallback(async () => {
    const { data: client } = await supabase()
      .from("clients")
      .select("name")
      .eq("id", clientId)
      .maybeSingle();
    setClientName((client as { name: string } | null)?.name ?? "");

    const { data, error: readError } = await supabase()
      .from("matches")
      .select(
        "id, verdict, relevance, retrieval, " +
          "grants(id, title, summary, url, country, currency, amount_min, amount_max, deadline, funders(name)), " +
          "eligibility_checks(rule_key, status, is_hard_gate, detail)",
      )
      .eq("client_id", clientId)
      .order("relevance", { ascending: false, nullsFirst: false });

    if (readError) {
      setError(readError.message);
      return;
    }
    setMatches((data ?? []) as unknown as MatchRow[]);
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Run it without being asked, once, when there is nothing to show.
   *
   * The consultant reached this screen by clicking "Find what they can apply
   * for" on the client. Making them then click "Find matches" is asking the
   * same question twice — the button carried no decision, only a delay. It
   * stays on the page as "Check again", because re-running after a profile
   * edit is a real choice.
   */
  useEffect(() => {
    if (autoRan.current || matches === null || matches.length > 0 || busy) return;
    autoRan.current = true;
    void run();
    // `run` is stable enough for this one-shot; re-running on its identity
    // would defeat the guard it depends on.
  }, [matches, busy]);

  async function run() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const response = await runMatching({ data: { clientId, accessToken: await accessToken() } });
      if (!response.ok) throw new Error(response.error);

      const { result } = response;
      // Say which halves of retrieval ran. A degraded run that looks identical
      // to a healthy one teaches the consultant to distrust the good ones too.
      const degraded = !result.usedVector
        ? " Meaning-based search was unavailable, so these are word matches only."
        : "";
      setNote(
        `Checked ${result.retrieved} calls: ${result.eligible} to apply for, ` +
          `${result.needsInput} awaiting an answer, ${result.ineligible} ruled out.${degraded}`,
      );
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const grouped = (verdict: Verdict) => (matches ?? []).filter((m) => m.verdict === verdict);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link
        to="/clients/$clientId"
        params={{ clientId }}
        className="text-sm text-[var(--color-accent)]"
      >
        ← {clientName || "Client"}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Matches</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-ink-soft)]">
        Every call below was checked against this client's profile by rules, not by a model. The
        reason each one was ruled in or out is stored with it.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          data-testid="run-matching"
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy
            ? "Checking the catalog…"
            : matches && matches.length > 0
              ? "Check again"
              : "Find matches"}
        </button>
        {note && (
          <p data-testid="match-summary" className="text-sm text-[var(--color-ink-soft)]">
            {note}
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-[var(--color-ineligible)]">
          {error}
        </p>
      )}

      {matches !== null && matches.length === 0 && !busy && (
        <p className="mt-8 text-sm text-[var(--color-ink-soft)]">
          Nothing came back for this profile. Add more detail about what this client does, then
          check again.
        </p>
      )}

      {GROUPS.map((group) => {
        const rows = grouped(group.verdict);
        if (rows.length === 0) return null;
        const collapsible = group.verdict === "ineligible";
        const open = !collapsible || showRuledOut;

        return (
          <section key={group.verdict} className="mt-10" data-testid={`group-${group.verdict}`}>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold">
                {group.heading}{" "}
                <span className="font-mono tabular-nums text-[var(--color-ink-soft)]">
                  {rows.length}
                </span>
              </h2>
              {collapsible && (
                <button
                  type="button"
                  onClick={() => setShowRuledOut((v) => !v)}
                  className="text-sm text-[var(--color-accent)]"
                >
                  {open ? "Hide" : "Show why"}
                </button>
              )}
            </div>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{group.blurb}</p>

            {open && (
              <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
                {rows.map((row) => (
                  <MatchCard key={row.id} row={row} clientId={clientId} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </main>
  );
}

const VERDICT_COLOR: Record<Verdict, string> = {
  eligible: "text-[var(--color-eligible)]",
  needs_input: "text-[var(--color-needs-input)]",
  ineligible: "text-[var(--color-ineligible)]",
};

function money(row: NonNullable<MatchRow["grants"]>): string | null {
  const unit = row.currency ?? "";
  if (row.amount_min && row.amount_max) {
    return `${unit} ${row.amount_min.toLocaleString()}–${row.amount_max.toLocaleString()}`;
  }
  if (row.amount_max) return `up to ${unit} ${row.amount_max.toLocaleString()}`;
  if (row.amount_min) return `from ${unit} ${row.amount_min.toLocaleString()}`;
  return null;
}

function MatchCard({ row, clientId }: { row: MatchRow; clientId: string }) {
  const grant = row.grants;
  if (!grant) return null;

  // The rule that actually decided this, shown first. A consultant scanning
  // forty results reads one line per result; the rest is for when they stop.
  const gates = row.eligibility_checks.filter((c) => c.is_hard_gate);
  const deciding =
    gates.find((c) => c.status === "fail") ??
    gates.find((c) => c.status === "unknown") ??
    row.eligibility_checks.find((c) => !c.is_hard_gate && c.status === "unknown");

  const amount = money(grant);
  const how = row.retrieval;

  return (
    <li className="bg-[var(--color-surface)] px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <a
          href={grant.url}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-[var(--color-accent)]"
        >
          {grant.title}
        </a>
        <span className={`shrink-0 text-xs font-medium ${VERDICT_COLOR[row.verdict]}`}>
          {row.verdict === "needs_input" ? "Needs an answer" : row.verdict}
        </span>
      </div>

      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
        {[grant.funders?.name, grant.country, amount, grant.deadline && `closes ${grant.deadline}`]
          .filter(Boolean)
          .join(" · ")}
      </p>

      {deciding && <p className="mt-2 text-sm">{deciding.detail}</p>}

      {/* Only where applying is actually possible. Offering to draft against a
          call the rules just ruled out would undo the verdict one line above. */}
      {row.verdict === "eligible" && (
        <Link
          to="/clients/$clientId/proposals/$grantId"
          params={{ clientId, grantId: grant.id }}
          data-testid="to-proposal"
          className="mt-2 inline-block text-sm font-medium text-[var(--color-accent)]"
        >
          Draft this application →
        </Link>
      )}

      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-[var(--color-ink-soft)]">
          Every rule, and how this was found
        </summary>
        <ul className="mt-2 flex flex-col gap-1 text-xs">
          {row.eligibility_checks.map((check) => (
            <li key={check.rule_key} className="flex gap-2">
              <span
                className={
                  check.status === "pass"
                    ? "text-[var(--color-eligible)]"
                    : check.status === "fail"
                      ? "text-[var(--color-ineligible)]"
                      : "text-[var(--color-ink-soft)]"
                }
              >
                {check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "?"}
              </span>
              <span>{check.detail}</span>
            </li>
          ))}
          <li className="mt-1 text-[var(--color-ink-soft)]">
            {/* Retrieval provenance: the first thing asked when a result looks wrong. */}
            {how?.lexicalRank && how?.vectorRank
              ? `Found by both wording (#${how.lexicalRank}) and meaning (#${how.vectorRank}).`
              : how?.lexicalRank
                ? `Found by wording (#${how.lexicalRank}).`
                : how?.vectorRank
                  ? `Found by meaning (#${how.vectorRank}).`
                  : "Retrieval provenance was not recorded for this match."}
          </li>
        </ul>
      </details>
    </li>
  );
}
