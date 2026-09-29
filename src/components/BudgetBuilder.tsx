import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { errorMessage } from "@/lib/error-message";
import { parseMoney } from "@/lib/parse-money";
import { formatMoney } from "@/lib/money";
import {
  checkBudget,
  computeBudget,
  lineCost,
  type BudgetTotals,
  type FundedBy,
} from "@/lib/budget";

type Line = {
  id: string;
  category: string;
  description: string | null;
  hours: number | null;
  rate: number | null;
  amount: number | null;
  funded_by: FundedBy;
};

const FUNDED_LABEL: Record<FundedBy, string> = {
  grant: "Grant request",
  cash_match: "Cash match",
  in_kind: "In-kind",
};

const inputClass =
  "mt-1 block w-full rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1.5 text-sm";
const labelClass = "text-xs uppercase tracking-wide text-[var(--color-ink-soft)]";

/**
 * The budget behind the brief's money fields, inside the brief (no new screen).
 * Totals are computed, never typed, and checked against the rules the call
 * published; a rule it did not publish is shown as unchecked.
 */
export function BudgetBuilder({
  clientId,
  grantId,
  currency,
  amountMin,
  amountMax,
  costSharePercent,
  inKindCapPercent,
  locked,
  onUseTotals,
}: {
  clientId: string;
  grantId: string;
  currency: string | null;
  amountMin: number | null;
  amountMax: number | null;
  costSharePercent: number | null;
  inKindCapPercent: number | null;
  locked: boolean;
  onUseTotals: (totals: BudgetTotals) => void;
}) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: readError } = await supabase()
      .from("brief_budget_lines")
      .select("id, category, description, hours, rate, amount, funded_by")
      .eq("client_id", clientId)
      .eq("grant_id", grantId)
      .order("sort_order")
      .order("created_at");
    if (readError) {
      setError(`Could not load the budget: ${readError.message}`);
      return;
    }
    setLines(
      ((data ?? []) as Line[]).map((l) => ({
        ...l,
        hours: l.hours === null ? null : Number(l.hours),
        rate: l.rate === null ? null : Number(l.rate),
        amount: l.amount === null ? null : Number(l.amount),
      })),
    );
  }, [clientId, grantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    setError(null);
    const category = String(form.get("category") ?? "").trim();
    const hoursRaw = String(form.get("hours") ?? "").trim();
    const hours = hoursRaw ? Number(hoursRaw) : null;
    const rate = parseMoney(String(form.get("rate") ?? ""));
    const amount = parseMoney(String(form.get("amount") ?? ""));
    if (!category) return setError("A budget line needs a category.");
    if ((hours !== null && !Number.isFinite(hours)) || Number.isNaN(rate) || Number.isNaN(amount)) {
      return setError("Not added — write hours as a number and money like 85, 1,200 or 5k.");
    }
    if (amount === null && (hours === null || rate === null)) {
      return setError("Not added — give hours and a rate, or a flat amount.");
    }
    setBusy("add");
    try {
      const { data, error: insertError } = await supabase()
        .from("brief_budget_lines")
        .insert({
          client_id: clientId,
          grant_id: grantId,
          category,
          description: String(form.get("description") ?? "").trim() || null,
          hours,
          rate,
          amount,
          funded_by: String(form.get("fundedBy") ?? "grant"),
          sort_order: lines?.length ?? 0,
        })
        .select("id, category, description, hours, rate, amount, funded_by")
        .single();
      if (insertError) throw insertError;
      setLines((current) => [...(current ?? []), { ...(data as Line), hours, rate, amount }]);
      formEl.reset();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function remove(line: Line) {
    setBusy(line.id);
    setError(null);
    try {
      const { error: deleteError } = await supabase()
        .from("brief_budget_lines")
        .delete()
        .eq("id", line.id);
      if (deleteError) throw deleteError;
      setLines((current) => (current ?? []).filter((l) => l.id !== line.id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  if (lines === null) {
    return error ? (
      <p role="alert" className="mt-4 text-sm text-[var(--color-ineligible)]">
        {error}
      </p>
    ) : null;
  }

  const totals = computeBudget(lines);
  const findings = checkBudget(totals, {
    currency,
    amountMin,
    amountMax,
    costSharePercent,
    inKindCapPercent,
  });
  const money = (n: number) => formatMoney(n, currency);
  const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 10) / 10}%`);

  return (
    <section className="mt-6" data-testid="budget-builder">
      <h3 className="text-sm font-semibold">Budget</h3>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
        Line items behind the request and the match, in{" "}
        {currency ?? "a currency the call does not publish"}.
      </p>

      {lines.length > 0 && (
        <table className="mt-3 w-full text-sm" data-testid="budget-lines">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              <th className="py-1 font-medium">Category</th>
              <th className="py-1 font-medium">Funded by</th>
              <th className="py-1 text-right font-medium">Cost</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className="border-t border-[var(--color-rule)]">
                <td className="py-1.5">
                  {line.category}
                  {line.description && (
                    <span className="text-[var(--color-ink-soft)]"> · {line.description}</span>
                  )}
                  {line.amount === null && (
                    <span className="text-[var(--color-ink-soft)]">
                      {" "}
                      · {line.hours} h × {money(line.rate ?? 0)}
                    </span>
                  )}
                </td>
                <td className="py-1.5">{FUNDED_LABEL[line.funded_by]}</td>
                <td className="py-1.5 text-right tabular-nums">{money(lineCost(line))}</td>
                <td className="py-1.5 text-right">
                  <button
                    type="button"
                    disabled={busy !== null || locked}
                    onClick={() => void remove(line)}
                    className="text-xs text-[var(--color-ink-soft)] disabled:opacity-50"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!locked && (
        <form
          onSubmit={add}
          data-testid="add-budget-line"
          className="mt-3 grid gap-2 sm:grid-cols-6"
        >
          <div className="sm:col-span-2">
            <label htmlFor="budget-category" className={labelClass}>
              Category
            </label>
            <input
              id="budget-category"
              name="category"
              placeholder="e.g. Staff"
              className={inputClass}
            />
          </div>
          <div className="sm:col-span-4">
            <label htmlFor="budget-description" className={labelClass}>
              Description
            </label>
            <input id="budget-description" name="description" className={inputClass} />
          </div>
          <div>
            <label htmlFor="budget-hours" className={labelClass}>
              Hours
            </label>
            <input id="budget-hours" name="hours" inputMode="decimal" className={inputClass} />
          </div>
          <div>
            <label htmlFor="budget-rate" className={labelClass}>
              Rate
            </label>
            <input id="budget-rate" name="rate" className={inputClass} />
          </div>
          <div>
            <label htmlFor="budget-amount" className={labelClass}>
              or amount
            </label>
            <input id="budget-amount" name="amount" className={inputClass} />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="budget-funded-by" className={labelClass}>
              Funded by
            </label>
            <select
              id="budget-funded-by"
              name="fundedBy"
              defaultValue="grant"
              className={inputClass}
            >
              {(Object.keys(FUNDED_LABEL) as FundedBy[]).map((key) => (
                <option key={key} value={key}>
                  {FUNDED_LABEL[key]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={busy !== null}
              className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {busy === "add" ? "Adding…" : "Add line"}
            </button>
          </div>
        </form>
      )}

      {lines.length > 0 && (
        <>
          <dl
            data-testid="budget-totals"
            className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4"
          >
            <dt className="text-[var(--color-ink-soft)]">Request</dt>
            <dd className="tabular-nums">{money(totals.request)}</dd>
            <dt className="text-[var(--color-ink-soft)]">Cash match</dt>
            <dd className="tabular-nums">{money(totals.cashMatch)}</dd>
            <dt className="text-[var(--color-ink-soft)]">In-kind</dt>
            <dd className="tabular-nums">{money(totals.inKind)}</dd>
            <dt className="text-[var(--color-ink-soft)]">Total cost</dt>
            <dd className="tabular-nums">{money(totals.totalCost)}</dd>
            <dt className="text-[var(--color-ink-soft)]">Match of total</dt>
            <dd className="tabular-nums">{pct(totals.matchPercent)}</dd>
            <dt className="text-[var(--color-ink-soft)]">In-kind share of match</dt>
            <dd className="tabular-nums">{pct(totals.inKindShareOfMatch)}</dd>
          </dl>
          {findings.length > 0 && (
            <ul data-testid="budget-findings" className="mt-3 flex flex-col gap-1 text-sm">
              {findings.map((f) => (
                <li
                  key={f.text}
                  className={
                    f.level === "violation"
                      ? "text-[var(--color-ineligible)]"
                      : "text-[var(--color-needs-input)]"
                  }
                >
                  {f.level === "violation" ? "Breaks the call: " : "Unchecked: "}
                  {f.text}
                </li>
              ))}
            </ul>
          )}
          {!locked && (
            <button
              type="button"
              onClick={() => onUseTotals(totals)}
              data-testid="use-budget-totals"
              className="mt-3 rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium"
            >
              Use budget totals in the brief
            </button>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-[var(--color-ineligible)]">
          {error}
        </p>
      )}
    </section>
  );
}
