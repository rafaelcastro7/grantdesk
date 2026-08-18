import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/")({ component: Home });

type Row = {
  id: string;
  status: string;
  client_id: string;
  grant_id: string;
  clients: { name: string } | null;
  grants: { title: string; deadline: string | null } | null;
  submissions: Array<{ submitted_at: string; outcome: string | null }>;
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

    const { data, error: readError } = await supabase()
      .from("proposals")
      .select(
        "id, status, client_id, grant_id, clients(name), grants(title, deadline), submissions(submitted_at, outcome)",
      );
    if (readError) {
      setError(readError.message);
      return;
    }
    setRows((data ?? []) as unknown as Row[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (rows ?? [])
    .filter((r) => r.submissions.length === 0)
    .sort((a, b) => {
      // A call with no published closing date is genuinely less urgent than one
      // that closes on Friday, so it sorts last rather than first.
      const left = a.grants?.deadline ?? "9999-12-31";
      const right = b.grants?.deadline ?? "9999-12-31";
      return left.localeCompare(right);
    });
  const sent = (rows ?? []).filter((r) => r.submissions.length > 0);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">What is due</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-ink-soft)]">
        Every application in progress, across every client, soonest first.
      </p>

      {error && (
        <p role="alert" className="mt-4 text-sm text-[var(--color-ineligible)]">
          {error}
        </p>
      )}

      {signedIn === false && (
        <p className="mt-8 text-sm">
          <Link to="/auth" className="text-[var(--color-accent)]">
            Sign in
          </Link>{" "}
          to see your clients.
        </p>
      )}

      {signedIn && rows !== null && open.length === 0 && sent.length === 0 && (
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
              <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{row.clients?.name}</p>
            </li>
          ))}
        </ul>
      )}

      {sent.length > 0 && (
        <section className="mt-10" data-testid="sent-list">
          <h2 className="text-sm font-semibold">Sent</h2>
          <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
            {sent.map((row) => (
              <li
                key={row.id}
                className="flex items-baseline justify-between gap-3 bg-[var(--color-surface)] px-4 py-3"
              >
                <span className="text-sm">
                  {row.grants?.title}
                  <span className="text-[var(--color-ink-soft)]"> · {row.clients?.name}</span>
                </span>
                <span className="shrink-0 text-xs text-[var(--color-ink-soft)]">
                  {row.submissions[0]?.outcome ?? "awaiting"} ·{" "}
                  {new Date(row.submissions[0]!.submitted_at).toLocaleDateString()}
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
  if (!date) {
    return <span className="shrink-0 text-xs text-[var(--color-ink-soft)]">no closing date</span>;
  }
  const days = Math.ceil((new Date(`${date}T23:59:59Z`).getTime() - Date.now()) / 86_400_000);
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
