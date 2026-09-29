import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { errorMessage } from "@/lib/error-message";
import { parseMoney } from "@/lib/parse-money";
import { formatMoney } from "@/lib/money";
import { REPORT_KIND_LABEL, type ReportKind } from "@/lib/post-award";

type Details = {
  amount: number | null;
  currency: string | null;
  start_on: string | null;
  end_on: string | null;
  notes: string | null;
};

type Report = {
  id: string;
  label: string;
  kind: ReportKind;
  due_on: string;
  submitted_on: string | null;
};

const inputClass =
  "mt-1 block w-full rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 py-2 text-sm";
const labelClass = "text-xs uppercase tracking-wide text-[var(--color-ink-soft)]";

/**
 * The award's terms and what it obliges the client to report (ADR-0007).
 * Shown once the outcome is "Awarded"; the reports it records appear on
 * "What is due" beside open applications.
 */
export function AwardPanel({
  proposalId,
  grantCurrency,
}: {
  proposalId: string;
  grantCurrency: string | null;
}) {
  const [details, setDetails] = useState<Details | null>(null);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [d, r] = await Promise.all([
      supabase()
        .from("award_details")
        .select("amount, currency, start_on, end_on, notes")
        .eq("proposal_id", proposalId)
        .maybeSingle(),
      supabase()
        .from("award_reports")
        .select("id, label, kind, due_on, submitted_on")
        .eq("proposal_id", proposalId)
        .order("due_on"),
    ]);
    const failed = d.error ?? r.error;
    if (failed) {
      setError(`Could not load the award: ${failed.message}`);
      return;
    }
    setDetails((d.data as Details | null) ?? null);
    setReports((r.data ?? []) as Report[]);
  }, [proposalId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, work: () => Promise<string>) {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      setNote(await work());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  function saveTerms(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim() || null;
    void act("terms", async () => {
      const amount = parseMoney(String(form.get("amount") ?? ""));
      if (Number.isNaN(amount)) {
        throw new Error("Not saved — could not read the award amount. Write it like 50000 or 50k.");
      }
      const row = {
        proposal_id: proposalId,
        amount,
        currency: text("currency")?.toUpperCase() ?? null,
        start_on: text("startOn"),
        end_on: text("endOn"),
        notes: text("notes"),
        updated_at: new Date().toISOString(),
      };
      const { error: saveError } = await supabase()
        .from("award_details")
        .upsert(row, { onConflict: "proposal_id" });
      if (saveError) {
        throw /check/.test(saveError.message)
          ? new Error("Not saved — the agreement cannot end before it starts.")
          : saveError;
      }
      setDetails(row);
      return "Award terms saved.";
    });
  }

  function addReport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const label = String(form.get("label") ?? "").trim();
    const dueOn = String(form.get("dueOn") ?? "").trim();
    const kind = String(form.get("kind") ?? "interim") as ReportKind;
    void act("add-report", async () => {
      if (!label || !dueOn) throw new Error("A report needs a name and a due date.");
      const { data, error: insertError } = await supabase()
        .from("award_reports")
        .insert({ proposal_id: proposalId, label, kind, due_on: dueOn })
        .select("id, label, kind, due_on, submitted_on")
        .single();
      if (insertError) throw insertError;
      setReports((current) =>
        [...(current ?? []), data as Report].sort((a, b) => a.due_on.localeCompare(b.due_on)),
      );
      formEl.reset();
      return "Report added. It now appears on What is due.";
    });
  }

  function setSubmitted(report: Report, submitted: boolean) {
    const submittedOn = submitted ? new Date().toISOString().slice(0, 10) : null;
    void act(report.id, async () => {
      const { error: updateError } = await supabase()
        .from("award_reports")
        .update({ submitted_on: submittedOn })
        .eq("id", report.id);
      if (updateError) throw updateError;
      setReports((current) =>
        (current ?? []).map((r) => (r.id === report.id ? { ...r, submitted_on: submittedOn } : r)),
      );
      return submitted ? "Marked as submitted." : "Marked as not yet submitted.";
    });
  }

  function remove(report: Report) {
    void act(report.id, async () => {
      const { error: deleteError } = await supabase()
        .from("award_reports")
        .delete()
        .eq("id", report.id);
      if (deleteError) throw deleteError;
      setReports((current) => (current ?? []).filter((r) => r.id !== report.id));
      return "Report removed.";
    });
  }

  if (reports === null) {
    return error ? (
      <p role="alert" className="mt-4 text-sm text-[var(--color-ineligible)]">
        {error}
      </p>
    ) : null;
  }
  const currency = details?.currency ?? grantCurrency;

  return (
    <section className="mt-6" data-testid="award-panel">
      <h3 className="text-sm font-semibold">Award terms</h3>
      {details?.amount != null && (
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          {formatMoney(details.amount, currency)}
          {details.start_on && details.end_on ? ` · ${details.start_on} to ${details.end_on}` : ""}
        </p>
      )}
      <form
        key={JSON.stringify(details)}
        onSubmit={saveTerms}
        data-testid="award-terms-form"
        className="mt-3 grid gap-3 sm:grid-cols-4"
      >
        <div className="sm:col-span-2">
          <label htmlFor="award-amount" className={labelClass}>
            Amount awarded
          </label>
          <input
            id="award-amount"
            name="amount"
            defaultValue={details?.amount ?? ""}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="award-currency" className={labelClass}>
            Currency
          </label>
          <input
            id="award-currency"
            name="currency"
            maxLength={3}
            defaultValue={currency ?? ""}
            placeholder="Not published"
            className={inputClass}
          />
        </div>
        <div />
        <div className="sm:col-span-2">
          <label htmlFor="award-start" className={labelClass}>
            Agreement starts
          </label>
          <input
            id="award-start"
            name="startOn"
            type="date"
            defaultValue={details?.start_on ?? ""}
            className={inputClass}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="award-end" className={labelClass}>
            Agreement ends
          </label>
          <input
            id="award-end"
            name="endOn"
            type="date"
            defaultValue={details?.end_on ?? ""}
            className={inputClass}
          />
        </div>
        <div className="sm:col-span-4">
          <label htmlFor="award-notes" className={labelClass}>
            Notes
          </label>
          <textarea
            id="award-notes"
            name="notes"
            rows={2}
            defaultValue={details?.notes ?? ""}
            className={inputClass}
          />
        </div>
        <div className="sm:col-span-4">
          <button
            type="submit"
            disabled={busy !== null}
            data-testid="save-award-terms"
            className="rounded-md border border-[var(--color-rule)] px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy === "terms" ? "Saving…" : "Save award terms"}
          </button>
        </div>
      </form>

      <h3 className="mt-6 text-sm font-semibold">Reporting obligations</h3>
      {reports.length === 0 ? (
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          None entered. Add each report the agreement requires; nothing is assumed.
        </p>
      ) : (
        <ul
          data-testid="award-reports"
          className="mt-2 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]"
        >
          {reports.map((report) => (
            <li
              key={report.id}
              className="flex flex-wrap items-baseline justify-between gap-2 bg-[var(--color-surface)] px-4 py-2 text-sm"
            >
              <span>
                {report.label}
                <span className="text-[var(--color-ink-soft)]">
                  {" "}
                  · {REPORT_KIND_LABEL[report.kind]} · due {report.due_on}
                  {report.submitted_on ? ` · submitted ${report.submitted_on}` : ""}
                </span>
              </span>
              <span className="flex gap-3">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setSubmitted(report, !report.submitted_on)}
                  className="text-xs text-[var(--color-accent)] disabled:opacity-50"
                >
                  {report.submitted_on ? "Mark not submitted" : "Mark as submitted"}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => remove(report)}
                  className="text-xs text-[var(--color-ink-soft)] disabled:opacity-50"
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={addReport}
        data-testid="add-report-form"
        className="mt-3 flex flex-wrap items-end gap-2"
      >
        <div className="min-w-48 flex-1">
          <label htmlFor="report-label" className={labelClass}>
            Report
          </label>
          <input
            id="report-label"
            name="label"
            placeholder="e.g. Year 1 progress report"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="report-kind" className={labelClass}>
            Kind
          </label>
          <select id="report-kind" name="kind" defaultValue="interim" className={inputClass}>
            {(Object.keys(REPORT_KIND_LABEL) as ReportKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {REPORT_KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="report-due" className={labelClass}>
            Due
          </label>
          <input id="report-due" name="dueOn" type="date" className={inputClass} />
        </div>
        <button
          type="submit"
          disabled={busy !== null}
          data-testid="add-report"
          className="rounded-md border border-[var(--color-rule)] px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy === "add-report" ? "Adding…" : "Add report"}
        </button>
      </form>

      {note && <p className="mt-2 text-sm text-[var(--color-ink-soft)]">{note}</p>}
      {error && (
        <p role="alert" className="mt-2 text-sm text-[var(--color-ineligible)]">
          {error}
        </p>
      )}
    </section>
  );
}
