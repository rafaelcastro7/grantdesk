import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { accessToken } from "@/lib/session";
import { useAction } from "@/lib/use-action";
import { useRequireSession } from "@/lib/use-require-session";
import { useDocumentTitle } from "@/lib/use-document-title";
import { formatMoney } from "@/lib/money";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { relevanceFrom } from "@/lib/match-explain";
import { bandOf } from "@/lib/regions";
import { axisBreakdown } from "@/lib/axis-breakdown";
import { findMatches } from "@/server/match.functions";
import {
  applyMatchFilters,
  DEFAULT_MATCH_FILTERS,
  isFiltering,
  type MatchFilters,
} from "@/lib/match-filters";

import { downloadText } from "@/lib/csv";
import { groupOf, verdictsCsv, type GroupKey, type Verdict } from "@/lib/verdict-export";

export const Route = createFileRoute("/clients_/$clientId/matches")({ component: MatchesPage });

type MatchRow = {
  id: string;
  verdict: Verdict;
  relevance: number | null;
  retrieval: {
    lexicalRank?: number | null;
    vectorRank?: number | null;
    terms?: string[];
  } | null;
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
const GROUPS: Array<{ verdict: GroupKey; heading: MessageKey; blurb: MessageKey }> = [
  {
    verdict: "eligible",
    heading: "matches.group.eligible",
    blurb: "matches.group.eligibleBlurb",
  },
  {
    verdict: "unverified",
    heading: "matches.group.unverified",
    blurb: "matches.group.unverifiedBlurb",
  },
  {
    verdict: "needs_input",
    heading: "matches.group.needsInput",
    blurb: "matches.group.needsInputBlurb",
  },
  {
    verdict: "ineligible",
    heading: "matches.group.ineligible",
    blurb: "matches.group.ineligibleBlurb",
  },
];

/**
 * How many rejections to render when the group is opened.
 *
 * Every rejection is stored — the record has to answer "did you even look at
 * that one?" months later. But a Canadian client against this catalog gets 51
 * of them, 51 for the same reason, and a wall of identical rows is not
 * evidence, it is noise wearing evidence's clothes. The heading still counts
 * all of them, and the list says what it is showing.
 */
const RULED_OUT_SHOWN = 12;

function MatchesPage() {
  useRequireSession();
  const { t } = useI18n();
  const { clientId } = Route.useParams();
  const runMatching = useServerFn(findMatches);

  const [clientName, setClientName] = useState<string>("");
  const [jurisdictions, setJurisdictions] = useState<string[]>([]);
  const [matches, setMatches] = useState<MatchRow[] | null>(null);
  const { busy, error, note, run, setError } = useAction();
  const [showRuledOut, setShowRuledOut] = useState(false);
  const [filters, setFilters] = useState<MatchFilters>(DEFAULT_MATCH_FILTERS);
  const autoRan = useRef(false);

  const load = useCallback(async () => {
    // Read alongside the client, not alongside each match row: it is one
    // fact about the client, not one per result, and grouping by it should
    // not depend on the join surviving a future column rename.
    const [clientResult, profileResult, matchResult] = await Promise.all([
      supabase().from("clients").select("name").eq("id", clientId).maybeSingle(),
      supabase()
        .from("client_profiles")
        .select("jurisdictions")
        .eq("client_id", clientId)
        .maybeSingle(),
      supabase()
        .from("matches")
        .select(
          "id, verdict, relevance, retrieval, " +
            "grants(id, title, summary, url, country, currency, amount_min, amount_max, deadline, funders(name)), " +
            "eligibility_checks(rule_key, status, is_hard_gate, detail)",
        )
        .eq("client_id", clientId)
        .order("relevance", { ascending: false, nullsFirst: false }),
    ]);
    // Any failure is shown: a failed profile read used to leave the home
    // country empty and quietly turn off home-country-first ordering.
    const readError = clientResult.error ?? profileResult.error ?? matchResult.error;
    if (readError) {
      setError(readError.message);
      return;
    }
    setClientName((clientResult.data as { name: string } | null)?.name ?? "");
    setJurisdictions(
      (profileResult.data as { jurisdictions: string[] | null } | null)?.jurisdictions ?? [],
    );
    const data = matchResult.data;
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
    void findAll();
    // `run` is stable enough for this one-shot; re-running on its identity
    // would defeat the guard it depends on.
  }, [matches, busy]);

  const findAll = (depth: 60 | 150 | 300 = 60) =>
    run("matching", async () => {
      const response = await runMatching({
        data: { clientId, accessToken: await accessToken(), depth },
      });
      if (!response.ok) throw new Error(response.error);

      const { result } = response;
      await load();
      // Say which halves of retrieval ran. A degraded run that looks identical
      // to a healthy one teaches the consultant to distrust the good ones too.
      const degraded = !result.usedVector ? t("matches.summaryDegraded") : "";
      // Say where the search actually looked, not just how many came back.
      // A flat count once hid the fact that a Canadian client's own country
      // was 30% of the ranking and 98% of it went unread — restating the
      // split every run is what keeps that from happening silently again.
      const home = result.bands.find((b) => b.key === "home");
      const where = home
        ? t("matches.summaryWhere", {
            home: home.label,
            homeCount: home.searched,
            americas: result.bands.find((b) => b.key === "americas")?.searched ?? 0,
          })
        : "";
      return (
        t("matches.summary", {
          retrieved: result.retrieved,
          eligible: result.eligible,
          needsInput: result.needsInput,
          ineligible: result.ineligible,
        }) +
        where +
        degraded
      );
    });

  /**
   * One verdict group, home country first.
   *
   * Relevance still orders each half — this does not re-rank anything — but a
   * consultant serving a Canadian client reads Canadian calls before American
   * ones regardless of which happened to score higher, because "priority" was
   * the actual ask and a relevance-only order cannot express it.
   */
  useDocumentTitle(t("matches.title"), clientName);
  const allOf = (verdict: GroupKey) => (matches ?? []).filter((m) => groupOf(m) === verdict);
  const grouped = (verdict: GroupKey) => {
    const filtered = applyMatchFilters(allOf(verdict), filters, {
      today: new Date(),
      isHome: (country) => bandOf(country, jurisdictions) === "home",
    });
    // An explicit sort is what the consultant asked for; only the default
    // relevance order gets the home-country-first split.
    if (filters.sort !== "relevance") return filtered;
    return filtered
      .map((m, index) => ({ m, index, band: bandOf(m.grants?.country, jurisdictions) }))
      .sort((a, b) => {
        const priority = (band: string) => (band === "home" ? 0 : 1);
        return priority(a.band) - priority(b.band) || a.index - b.index;
      })
      .map(({ m }) => m);
  };
  const filtering = isFiltering(filters);
  const currencies = [
    ...new Set(
      (matches ?? []).map((m) => m.grants?.currency?.toUpperCase()).filter((c): c is string => !!c),
    ),
  ].sort();
  const countries = [
    ...new Set(
      (matches ?? []).map((m) => m.grants?.country?.toUpperCase()).filter((c): c is string => !!c),
    ),
  ].sort();
  const set = (patch: Partial<MatchFilters>) => setFilters((current) => ({ ...current, ...patch }));

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link
        to="/clients/$clientId"
        params={{ clientId }}
        className="text-sm text-[var(--color-accent)]"
      >
        ← {clientName || t("matches.backFallback")}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">{t("matches.title")}</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-ink-soft)]">{t("matches.intro")}</p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => findAll()}
          disabled={busy !== null}
          data-testid="run-matching"
          className="rounded-md bg-[var(--color-accent-strong)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy
            ? t("matches.checking")
            : matches && matches.length > 0
              ? t("matches.checkAgain")
              : t("matches.find")}
        </button>
        {matches && matches.length > 0 && (
          <button
            type="button"
            onClick={() => findAll(300)}
            disabled={busy !== null}
            data-testid="run-matching-deep"
            title={t("matches.deeperTitle")}
            className="rounded-md border border-[var(--color-rule)] px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {t("matches.deeper")}
          </button>
        )}
        {matches && matches.length > 0 && (
          <button
            type="button"
            onClick={() =>
              downloadText(
                `verdicts-${(clientName || "client").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`,
                verdictsCsv(matches),
                "text/csv;charset=utf-8",
              )
            }
            data-testid="export-verdicts"
            title="Every match with its group and each rule's result — ruled-out calls included"
            className="rounded-md border border-[var(--color-rule)] px-4 py-2 text-sm font-medium"
          >
            Export verdicts (CSV)
          </button>
        )}
        {note && (
          <p
            data-testid="match-summary"
            aria-live="polite"
            className="text-sm text-[var(--color-ink-soft)]"
          >
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
        <p className="mt-8 text-sm text-[var(--color-ink-soft)]">{t("matches.empty")}</p>
      )}

      {matches !== null && matches.length > 0 && (
        <section
          data-testid="match-filters"
          aria-label={t("matches.filter.aria")}
          className="mt-6 grid gap-3 rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-4 text-sm sm:grid-cols-3"
        >
          <label className="flex flex-col gap-1 sm:col-span-3">
            <span className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              {t("matches.filter.search")}
            </span>
            <input
              type="search"
              aria-label={t("matches.filter.search")}
              value={filters.text}
              onChange={(e) => set({ text: e.target.value })}
              placeholder={t("matches.filter.searchPlaceholder")}
              className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              {t("matches.filter.closes")}
            </span>
            <select
              aria-label={t("matches.filter.closes")}
              value={filters.closes}
              onChange={(e) => set({ closes: e.target.value as MatchFilters["closes"] })}
              className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1.5"
            >
              <option value="any">{t("matches.filter.closesAny")}</option>
              <option value="30">{t("matches.filter.closes30")}</option>
              <option value="90">{t("matches.filter.closes90")}</option>
              <option value="rolling">{t("matches.filter.closesRolling")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              {t("matches.filter.role")}
            </span>
            <select
              aria-label={t("matches.filter.role")}
              value={filters.role}
              onChange={(e) => set({ role: e.target.value as MatchFilters["role"] })}
              className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1.5"
            >
              <option value="any">{t("matches.filter.roleAny")}</option>
              <option value="lead">{t("matches.filter.roleLead")}</option>
              <option value="funded_partner">{t("matches.filter.rolePartner")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              {t("matches.filter.currency")}
            </span>
            <select
              aria-label={t("matches.filter.currency")}
              value={filters.currency}
              onChange={(e) => set({ currency: e.target.value })}
              className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1.5"
            >
              <option value="any">{t("matches.filter.currencyAny")}</option>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              {t("matches.filter.country")}
            </span>
            <select
              aria-label={t("matches.filter.country")}
              value={filters.country}
              onChange={(e) => set({ country: e.target.value })}
              className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1.5"
            >
              <option value="any">{t("matches.filter.countryAny")}</option>
              {countries.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              {t("matches.filter.minAmount")}
              {filters.currency !== "any" ? ` (${filters.currency})` : ""}
            </span>
            <input
              type="text"
              inputMode="numeric"
              aria-label={t("matches.filter.minAmount")}
              value={filters.minAmount ?? ""}
              disabled={filters.currency === "any"}
              title={filters.currency === "any" ? t("matches.filter.chooseCurrency") : undefined}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/[^\d]/g, ""));
                set({ minAmount: e.target.value.trim() && n > 0 ? n : null });
              }}
              placeholder={
                filters.currency === "any"
                  ? t("matches.filter.chooseCurrency")
                  : t("matches.filter.minPlaceholder")
              }
              className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1.5 disabled:opacity-50"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              {t("matches.filter.sort")}
            </span>
            <select
              aria-label={t("matches.filter.sort")}
              value={filters.sort}
              onChange={(e) => set({ sort: e.target.value as MatchFilters["sort"] })}
              className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1.5"
            >
              <option value="relevance">{t("matches.filter.sortRelevance")}</option>
              <option value="deadline">{t("matches.filter.sortDeadline")}</option>
              <option value="amount">{t("matches.filter.sortAmount")}</option>
            </select>
          </label>
          <label className="flex items-center gap-2 self-end">
            <input
              type="checkbox"
              checked={filters.fitOnly}
              onChange={(e) => set({ fitOnly: e.target.checked })}
            />
            {t("matches.filter.fitOnly")}
          </label>
          <label className="flex items-center gap-2 self-end">
            <input
              type="checkbox"
              checked={filters.homeOnly}
              onChange={(e) => set({ homeOnly: e.target.checked })}
            />
            {t("matches.filter.homeOnly")}
          </label>
          {filtering && (
            <button
              type="button"
              onClick={() => setFilters(DEFAULT_MATCH_FILTERS)}
              className="self-end text-left text-[var(--color-accent)] sm:col-span-3"
            >
              {t("matches.filter.clear")}
            </button>
          )}
        </section>
      )}

      {GROUPS.map((group) => {
        const rows = grouped(group.verdict);
        const total = allOf(group.verdict).length;
        if (total === 0) return null;
        const collapsible = group.verdict === "ineligible";
        const open = !collapsible || showRuledOut;
        const visible = collapsible ? rows.slice(0, RULED_OUT_SHOWN) : rows;

        return (
          <section key={group.verdict} className="mt-10" data-testid={`group-${group.verdict}`}>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold">
                {t(group.heading)}{" "}
                <span className="font-mono tabular-nums text-[var(--color-ink-soft)]">
                  {filtering ? t("matches.group.countOf", { shown: rows.length, total }) : total}
                </span>
              </h2>
              {collapsible && (
                <button
                  type="button"
                  onClick={() => setShowRuledOut((v) => !v)}
                  className="text-sm text-[var(--color-accent)]"
                >
                  {open ? t("matches.group.hide") : t("matches.group.showWhy")}
                </button>
              )}
            </div>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{t(group.blurb)}</p>
            {open && rows.length === 0 && (
              <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
                {t("matches.group.allHidden", { total })}
              </p>
            )}

            {open && rows.length > 0 && (
              <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
                {visible.map((row) => (
                  <MatchCard
                    key={row.id}
                    row={row}
                    clientId={clientId}
                    isHome={bandOf(row.grants?.country, jurisdictions) === "home"}
                  />
                ))}
                {visible.length < rows.length && (
                  <li
                    data-testid="ruled-out-truncated"
                    className="bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-ink-soft)]"
                  >
                    {t("matches.group.truncated", { shown: visible.length, total: rows.length })}
                  </li>
                )}
              </ul>
            )}
          </section>
        );
      })}
    </main>
  );
}

/**
 * Which profile field a hard-gate "unknown" is actually waiting on. Only the
 * checks that can produce a needs_input verdict (assessSubmission's gates)
 * need an entry — the others never leave a client stuck on this screen.
 */
const FIELD_FOR_RULE: Partial<Record<string, string>> = {
  jurisdiction: "profile-jurisdictions",
  applicant_type: "profile-stage",
};

const VERDICT_LABEL: Record<Verdict, MessageKey> = {
  eligible: "matches.verdict.eligible",
  needs_input: "matches.verdict.needsInput",
  ineligible: "matches.verdict.ineligible",
};

const VERDICT_COLOR: Record<Verdict, string> = {
  eligible: "text-[var(--color-eligible)]",
  needs_input: "text-[var(--color-needs-input)]",
  ineligible: "text-[var(--color-ineligible)]",
};

function money(
  row: NonNullable<MatchRow["grants"]>,
  t: ReturnType<typeof useI18n>["t"],
): string | null {
  if (row.amount_min && row.amount_max) {
    return `${formatMoney(row.amount_min, row.currency)} – ${formatMoney(row.amount_max, row.currency)}`;
  }
  if (row.amount_max)
    return t("matches.card.upTo", { amount: formatMoney(row.amount_max, row.currency) });
  if (row.amount_min)
    return t("matches.card.from", { amount: formatMoney(row.amount_min, row.currency) });
  return null;
}

function MatchCard({
  row,
  clientId,
  isHome,
}: {
  row: MatchRow;
  clientId: string;
  /** This client's own country, shown so priority is visible, not just implied by order. */
  isHome: boolean;
}) {
  const { t } = useI18n();
  const grant = row.grants;
  if (!grant) return null;

  // The rule that actually decided this, shown first. A consultant scanning
  // forty results reads one line per result; the rest is for when they stop.
  const gates = row.eligibility_checks.filter((c) => c.is_hard_gate);
  const deciding =
    gates.find((c) => c.status === "fail") ??
    gates.find((c) => c.status === "unknown") ??
    row.eligibility_checks.find((c) => !c.is_hard_gate && c.status === "unknown");

  const amount = money(grant, t);
  const how = row.retrieval;
  const axes = axisBreakdown(
    row.eligibility_checks.map((c) => ({
      key: c.rule_key,
      status: c.status,
      isHardGate: c.is_hard_gate,
      detail: c.detail,
    })),
  );

  return (
    <li data-testid="match-card" className="bg-[var(--color-surface)] px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <a
          href={grant.url}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-[var(--color-accent)]"
        >
          {grant.title}
        </a>
        <span
          className={`shrink-0 text-xs font-medium ${
            groupOf(row) === "unverified"
              ? "text-[var(--color-needs-input)]"
              : VERDICT_COLOR[row.verdict]
          }`}
        >
          {groupOf(row) === "unverified"
            ? t("matches.verdict.unverified")
            : t(VERDICT_LABEL[row.verdict])}
        </span>
      </div>

      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
        {[
          grant.funders?.name,
          // Home is stated, not just implied by list order — the order
          // survives a re-sort or a copy-paste, the label does not need to.
          isHome ? t("matches.card.home", { country: grant.country }) : grant.country,
          amount,
          grant.deadline && t("matches.card.closes", { date: grant.deadline }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      {deciding && (
        <p className="mt-2 text-sm">
          {deciding.detail}
          {row.verdict === "needs_input" && FIELD_FOR_RULE[deciding.rule_key] && (
            <>
              {" "}
              <Link
                to="/clients/$clientId"
                params={{ clientId }}
                hash={FIELD_FOR_RULE[deciding.rule_key]}
                className="font-medium text-[var(--color-accent)]"
              >
                {t("matches.card.fillIn")}
              </Link>
            </>
          )}
        </p>
      )}

      {/* Eligibility and relevance are different questions and are never
          blurred into one number. The incumbent shows a match score with
          nothing behind it, and its own users describe re-checking every
          result by hand — a claim you have to verify is worth less than no
          claim. This one is checkable against the call in a second. */}
      <p data-testid="why-relevant" className="mt-1 text-sm text-[var(--color-ink-soft)]">
        {relevanceFrom(row.retrieval?.terms ?? [], row.retrieval).statement}
      </p>

      {/* What kind of thing is settled and what kind is still a judgment
          call — sorted, not scored. A single number here would have to blend
          "restricted to a country you're not in" with "this award is a bit
          large for your budget", and there is no honest way to average a
          fact with a guess. */}
      {axes.length > 0 && (
        <ul data-testid="axis-breakdown" className="mt-2 flex flex-wrap gap-2 text-xs">
          {axes.map((axis) => (
            <li
              key={axis.key}
              title={axis.reasons.join(" ")}
              className={`rounded-full border px-2 py-0.5 ${
                axis.status === "fail"
                  ? "border-[var(--color-ineligible)] text-[var(--color-ineligible)]"
                  : axis.status === "pass"
                    ? "border-[var(--color-eligible)] text-[var(--color-eligible)]"
                    : "border-[var(--color-rule)] text-[var(--color-ink-soft)]"
              }`}
            >
              {axis.label}
              {axis.status === "fail"
                ? " ✗"
                : axis.status === "pass"
                  ? " ✓"
                  : axis.status === "partial"
                    ? " ~"
                    : " ?"}
            </li>
          ))}
        </ul>
      )}

      {/* Only where applying is actually possible. Offering to draft against a
          call the rules just ruled out would undo the verdict one line above. */}
      {row.verdict === "eligible" && (
        <Link
          to="/clients/$clientId/proposals/$grantId"
          params={{ clientId, grantId: grant.id }}
          data-testid="to-proposal"
          aria-label={t("matches.card.draftAria", { title: grant.title })}
          className="mt-2 inline-block text-sm font-medium text-[var(--color-accent)]"
        >
          {t("matches.card.draft")}
        </Link>
      )}
      {/* A partner question is answered by qualifying the call, not by
          drafting it: the brief is where the lead partner, the cost share and
          the leadership decision get written down. */}
      {row.verdict === "needs_input" && (
        <Link
          to="/clients/$clientId/proposals/$grantId"
          params={{ clientId, grantId: grant.id }}
          data-testid="to-brief"
          aria-label={t("matches.card.briefAria", { title: grant.title })}
          className="mt-2 inline-block text-sm font-medium text-[var(--color-accent)]"
        >
          {t("matches.card.brief")}
        </Link>
      )}

      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-[var(--color-ink-soft)]">
          {t("matches.card.everyRule")}
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
              ? t("matches.card.foundBoth", { lexical: how.lexicalRank, vector: how.vectorRank })
              : how?.lexicalRank
                ? t("matches.card.foundWording", { lexical: how.lexicalRank })
                : how?.vectorRank
                  ? t("matches.card.foundMeaning", { vector: how.vectorRank })
                  : t("matches.card.noProvenance")}
          </li>
        </ul>
      </details>
    </li>
  );
}
