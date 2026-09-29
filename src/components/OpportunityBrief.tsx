import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import {
  briefDocument,
  briefFilename,
  briefMarkdown,
  type BriefCall,
  type BriefDocument,
} from "@/lib/brief-export";
import { downloadText } from "@/lib/csv";
import { errorMessage } from "@/lib/error-message";
import { draftingGate, fromRow, type Decision, type DraftingGate } from "@/lib/go-decision";
import { parseMoney } from "@/lib/parse-money";
import { unsignedChecks } from "@/lib/assignments";
import { detectCostSharePercent, detectInKindCapPercent } from "@/lib/eligibility";
import type { BudgetTotals } from "@/lib/budget";
import { BudgetBuilder } from "./BudgetBuilder";
import { useI18n, type MessageKey } from "@/lib/i18n";

type BriefRow = {
  role: "lead" | "funded_partner" | "other" | null;
  role_other: string | null;
  intake: "fixed" | "rolling" | null;
  application_structure: "one_stage" | "two_stage" | null;
  strategic_angle: string | null;
  mandatory_components: string | null;
  request_amount: number | null;
  net_revenue: number | null;
  match_required: number | null;
  in_kind_cap: number | null;
  cash_match_confirmed: boolean;
  risks: string | null;
  recommendation: "go" | "no_go" | "go_conditional" | null;
  recommendation_reason: string | null;
  condition: string | null;
  decision: Decision;
  condition_met: boolean;
  decided_by: string | null;
  decision_reason: string | null;
  decided_at: string | null;
  partner_contact: string | null;
  pitch_approved_by: string | null;
  cash_match_verified_by: string | null;
  cash_match_verified_on: string | null;
  capacity_verified_by: string | null;
  capacity_verified_on: string | null;
  updated_at: string | null;
  /** The signed-in account that recorded the decision, set by the database. */
  recorder: { email: string } | null;
};

const COLUMNS =
  "role, role_other, intake, application_structure, strategic_angle, mandatory_components, " +
  "request_amount, net_revenue, match_required, in_kind_cap, cash_match_confirmed, risks, " +
  "recommendation, recommendation_reason, condition, decision, condition_met, decided_by, " +
  "decision_reason, decided_at, partner_contact, pitch_approved_by, cash_match_verified_by, " +
  "cash_match_verified_on, capacity_verified_by, capacity_verified_on, updated_at, recorder:consultants!opportunity_decisions_decided_by_user_fkey(email)";

export type BriefPrefill = {
  deadline: string | null;
  amountMax: number | null;
  amountMin?: number | null;
  currency: string | null;
  /** The call's eligibility and summary text, read for cost-share and in-kind caps. */
  costShareText?: string;
  mandatoryComponents: string;
  risks: string;
};

const EMPTY_BRIEF: BriefRow = {
  role: null,
  role_other: null,
  intake: null,
  application_structure: null,
  strategic_angle: null,
  mandatory_components: null,
  request_amount: null,
  net_revenue: null,
  match_required: null,
  in_kind_cap: null,
  cash_match_confirmed: false,
  risks: null,
  recommendation: null,
  recommendation_reason: null,
  condition: null,
  decision: "pending",
  condition_met: false,
  decided_by: null,
  decision_reason: null,
  decided_at: null,
  partner_contact: null,
  pitch_approved_by: null,
  cash_match_verified_by: null,
  cash_match_verified_on: null,
  capacity_verified_by: null,
  capacity_verified_on: null,
  updated_at: null,
  recorder: null,
};

const DECISION_LABEL: Record<Decision, MessageKey> = {
  pending: "brief.decision.pending",
  go: "brief.decision.go",
  no_go: "brief.decision.no_go",
  go_conditional: "brief.decision.go_conditional",
};

/**
 * The one-page Opportunity Brief and the leadership go / no-go on it.
 *
 * Lives on the proposal screen rather than a screen of its own (ADR-0006): it
 * answers "what does this call require of us, and are we doing it", which is
 * this screen's question. Drafting below stays locked until a decision opens it.
 */
export function OpportunityBrief({
  clientId,
  grantId,
  onGate,
  prefill,
  call,
  locked = false,
  ready = true,
}: {
  clientId: string;
  grantId: string;
  /** The call's published facts, for the printed and downloaded brief. */
  call: BriefCall;
  onGate: (gate: DraftingGate) => void;
  /** What the catalog and the rules already know, used when no brief exists yet. */
  prefill: BriefPrefill;
  /** After submission the record must match what was sent. */
  locked?: boolean;
  /** False while the call is still being read; a new brief waits for it. */
  ready?: boolean;
}) {
  const { t, locale, language } = useI18n();
  const [row, setRow] = useState<BriefRow | null>(null);
  const [required, setRequired] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [roleFromRules, setRoleFromRules] = useState<BriefRow["role"]>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const load = useCallback(async () => {
    const [decisionResult, policyResult, matchResult] = await Promise.all([
      supabase()
        .from("opportunity_decisions")
        .select(COLUMNS)
        .eq("client_id", clientId)
        .eq("grant_id", grantId)
        .maybeSingle(),
      supabase()
        .from("client_profiles")
        .select("requires_go_decision")
        .eq("client_id", clientId)
        .maybeSingle(),
      supabase()
        .from("matches")
        .select("eligibility_checks(rule_key, status, detail)")
        .eq("client_id", clientId)
        .eq("grant_id", grantId)
        .maybeSingle(),
    ]);
    const error = decisionResult.error ?? policyResult.error;
    if (error) {
      // Unknown state is treated as locked: showing a blank, saveable form
      // here would let one click overwrite the real brief with nothing.
      setFailure(t("brief.loadFailed", { error: error.message }));
      onGate({
        allowed: false,
        reason: t("brief.loadFailedGate"),
      });
      return;
    }
    const found = (decisionResult.data as unknown as BriefRow | null) ?? null;
    const mustDecide = !!(policyResult.data as { requires_go_decision?: boolean } | null)
      ?.requires_go_decision;
    const checks =
      (
        matchResult.data as {
          eligibility_checks: Array<{ rule_key: string; status: string; detail: string }>;
        } | null
      )?.eligibility_checks ?? [];
    const role = checks.find((c) => c.rule_key === "role");
    setRoleFromRules(
      role?.status === "pass"
        ? /funded partner/i.test(role.detail)
          ? "funded_partner"
          : "lead"
        : null,
    );
    setRow(found);
    setRequired(mustDecide);
    setLoaded(true);
    setFailure(null);
    onGate(draftingGate(fromRow(found), mustDecide));
  }, [clientId, grantId, onGate, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim() || null;
    const unreadable: string[] = [];
    const money = (key: string, label: string) => {
      const value = parseMoney(String(form.get(key) ?? ""));
      if (Number.isNaN(value)) unreadable.push(label);
      return value !== null && Number.isFinite(value) ? value : null;
    };
    const amounts = {
      request_amount: money("requestAmount", t("brief.requestAmount")),
      net_revenue: money("netRevenue", t("brief.netRevenue")),
      match_required: money("matchRequired", t("brief.matchRequired")),
      in_kind_cap: money("inKindCap", t("brief.inKindCap")),
    };
    if (unreadable.length > 0) {
      setFailure(t("brief.unreadable", { fields: unreadable.join(", ") }));
      return;
    }
    const decision = (text("decision") ?? "pending") as Decision;
    // Leadership may overrule the recommendation — but a GO over a no-go
    // recommendation (or the reverse) with no stated reason is either a slip
    // or an undocumented call, and the record is where "why?" gets answered.
    const recommendation = text("recommendation");
    const overrules =
      (recommendation === "no_go" && (decision === "go" || decision === "go_conditional")) ||
      (recommendation === "go" && decision === "no_go");
    if (overrules && !text("decisionReason")) {
      setFailure(t("brief.overrules"));
      return;
    }

    // A date with no name says a check happened without saying who stands
    // behind it, which is the one thing the SOP's Stage 2 record is for.
    const unsigned = unsignedChecks({
      "cash match": [text("cashMatchVerifiedBy"), text("cashMatchVerifiedOn")],
      capacity: [text("capacityVerifiedBy"), text("capacityVerifiedOn")],
    });
    if (unsigned.length > 0) {
      setFailure(
        `Not saved — the ${unsigned.join(" and ")} check has a date but no name. Write who verified it.`,
      );
      return;
    }

    setSaving(true);
    setMessage(null);
    setFailure(null);
    try {
      const fields = {
        client_id: clientId,
        grant_id: grantId,
        role: text("role"),
        role_other: text("roleOther"),
        intake: text("intake"),
        application_structure: text("applicationStructure"),
        strategic_angle: text("strategicAngle"),
        mandatory_components: text("mandatoryComponents"),
        ...amounts,
        cash_match_confirmed: form.get("cashMatchConfirmed") === "on",
        risks: text("risks"),
        recommendation: text("recommendation"),
        recommendation_reason: text("recommendationReason"),
        condition: text("condition"),
        decision,
        condition_met: form.get("conditionMet") === "on",
        decided_by: text("decidedBy"),
        decision_reason: text("decisionReason"),
        // Stamped when a decision is recorded, kept when only the brief moves.
        decided_at:
          decision === "pending"
            ? null
            : decision === row?.decision && row?.decided_at
              ? row.decided_at
              : new Date().toISOString(),
        partner_contact: text("partnerContact"),
        pitch_approved_by: text("pitchApprovedBy"),
        cash_match_verified_by: text("cashMatchVerifiedBy"),
        cash_match_verified_on: text("cashMatchVerifiedOn"),
        capacity_verified_by: text("capacityVerifiedBy"),
        capacity_verified_on: text("capacityVerifiedOn"),
        updated_at: new Date().toISOString(),
      };
      // Only over the version this page loaded. Two people saving one brief
      // used to mean the last save silently replaced the other's decision.
      if (row) {
        const { data: saved, error } = await supabase()
          .from("opportunity_decisions")
          .update(fields)
          .eq("client_id", clientId)
          .eq("grant_id", grantId)
          .eq("updated_at", row.updated_at)
          .select("updated_at");
        if (error) throw error;
        if (!saved || saved.length === 0) throw new Error(t("brief.conflict"));
      } else {
        const { error } = await supabase().from("opportunity_decisions").insert(fields);
        if (error?.code === "23505") throw new Error(t("brief.conflict"));
        if (error) throw error;
      }
      await load();
      setMessage(decision === "pending" ? t("brief.saved") : t("brief.recorded"));
    } catch (caught) {
      const text = errorMessage(caught);
      setFailure(
        /decided_by/.test(text) || /check constraint/.test(text) ? t("brief.constraint") : text,
      );
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return failure ? (
      <section className="mt-10" data-testid="opportunity-brief">
        <p role="alert" className="text-sm text-[var(--color-ineligible)]">
          {failure}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-2 text-sm text-[var(--color-accent)]"
        >
          {t("brief.tryAgain")}
        </button>
      </section>
    ) : null;
  }
  const gate = draftingGate(fromRow(row), required);
  // A stored brief wins; otherwise start from what is already known, so the
  // consultant confirms facts instead of retyping them from the call.
  const r: BriefRow = row ?? {
    ...EMPTY_BRIEF,
    role: roleFromRules,
    intake: prefill.deadline ? "fixed" : "rolling",
    request_amount: prefill.amountMax,
    mandatory_components: prefill.mandatoryComponents || null,
    risks: prefill.risks || null,
  };
  // Keyed only on the saved version. A new brief is rendered once, after the
  // call has been read, so nothing arriving later can remount it under the
  // consultant's typing.
  const k = row ? `saved-${row.updated_at}` : "new";
  const unit = prefill.currency ?? t("brief.noCurrency");
  const costSharePercent = detectCostSharePercent(prefill.costShareText);
  const inKindCapPercent = detectInKindCapPercent(prefill.costShareText);

  // Writes into the uncontrolled form rather than saving: the brief is a record
  // leadership signs, so the totals land as edits the consultant then saves.
  function applyBudgetTotals(totals: BudgetTotals) {
    const form = formRef.current;
    if (!form) return;
    const set = (name: string, value: number) => {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement) field.value = String(Math.round(value * 100) / 100);
    };
    set("requestAmount", totals.request);
    set("matchRequired", totals.match);
    // The brief's cap is the funder's limit in money, which only exists when
    // the call states a percentage; the budget's own in-kind is not a cap.
    if (inKindCapPercent !== null) set("inKindCap", (inKindCapPercent / 100) * totals.match);
    setFailure(null);
    setMessage(
      inKindCapPercent === null ? t("brief.budgetAppliedNoCap") : t("brief.budgetApplied"),
    );
  }

  // Exports describe what is saved (or the pre-fill), never unsaved typing.
  const doc = briefDocument(call, { ...r, recorderEmail: r.recorder?.email ?? null }, !!row);

  function printBrief() {
    const root = document.documentElement;
    root.dataset.print = "brief";
    const done = () => {
      delete root.dataset.print;
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
  }

  return (
    <section className="mt-10" data-testid="opportunity-brief">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{t("brief.title")}</h2>
        <div className="flex flex-wrap items-baseline gap-2">
          <button
            type="button"
            onClick={printBrief}
            data-testid="print-brief"
            className="rounded-md border border-[var(--color-rule)] px-3 py-1 text-xs font-medium"
          >
            {t("brief.print")}
          </button>
          <button
            type="button"
            onClick={() =>
              downloadText(
                briefFilename(call.title),
                briefMarkdown(doc),
                "text/markdown;charset=utf-8",
              )
            }
            data-testid="download-brief"
            className="rounded-md border border-[var(--color-rule)] px-3 py-1 text-xs font-medium"
          >
            {t("brief.download")}
          </button>
          <span
            data-testid="go-decision"
            className={`text-xs font-semibold uppercase tracking-wide ${
              gate.allowed ? "text-[var(--color-eligible)]" : "text-[var(--color-needs-input)]"
            }`}
          >
            {t(DECISION_LABEL[r?.decision ?? "pending"])}
          </span>
        </div>
      </div>
      {typeof document !== "undefined" && createPortal(<PrintedBrief doc={doc} />, document.body)}
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
        {required ? t("brief.introRequired") : t("brief.introOptional")}
      </p>

      {!row && !ready ? (
        <p data-testid="brief-preparing" className="mt-3 text-sm text-[var(--color-ink-soft)]">
          {t("brief.preparing")}
        </p>
      ) : (
        <form
          key={k}
          ref={formRef}
          onSubmit={save}
          className="mt-3 grid gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)] sm:grid-cols-2"
        >
          <Choice
            name="role"
            label={t("brief.role")}
            value={r?.role}
            options={[
              ["lead", t("brief.role.lead")],
              ["funded_partner", t("brief.role.funded_partner")],
              ["other", t("brief.role.other")],
            ]}
          />
          <Text name="roleOther" label={t("brief.roleOther")} value={r?.role_other} />
          <Choice
            name="intake"
            label={t("brief.intake")}
            value={r?.intake}
            options={[
              ["fixed", t("brief.intake.fixed")],
              ["rolling", t("brief.intake.rolling")],
            ]}
          />
          <Choice
            name="applicationStructure"
            label={t("brief.structure")}
            value={r?.application_structure}
            options={[
              ["one_stage", t("brief.structure.one_stage")],
              ["two_stage", t("brief.structure.two_stage")],
            ]}
          />
          <Area
            name="strategicAngle"
            label={t("brief.strategicAngle")}
            hint={t("brief.strategicAngleHint")}
            value={r?.strategic_angle}
          />
          <Area
            name="mandatoryComponents"
            label={t("brief.mandatory")}
            hint={t("brief.mandatoryHint")}
            value={r?.mandatory_components}
          />
          <Text
            name="requestAmount"
            label={t("brief.withUnit", { label: t("brief.requestAmount"), unit })}
            value={r.request_amount}
          />
          <Text
            name="netRevenue"
            label={t("brief.withUnit", { label: t("brief.netRevenue"), unit })}
            value={r.net_revenue}
          />
          <Text
            name="matchRequired"
            label={t("brief.withUnit", { label: t("brief.matchRequired"), unit })}
            value={r.match_required}
          />
          <Text
            name="inKindCap"
            label={t("brief.withUnit", { label: t("brief.inKindCap"), unit })}
            value={r.in_kind_cap}
          />
          <Check
            name="cashMatchConfirmed"
            label={t("brief.cashMatch")}
            value={r?.cash_match_confirmed}
          />
          <div className="bg-[var(--color-accent-soft)] px-4 py-3 sm:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wide">
              Stage 2 — who checked what
            </p>
          </div>
          <Text name="partnerContact" label="Partner contact" value={r.partner_contact} />
          <Text name="pitchApprovedBy" label="Pitch approved by" value={r.pitch_approved_by} />
          <Text
            name="cashMatchVerifiedBy"
            label="Cash match verified by"
            value={r.cash_match_verified_by}
          />
          <Text
            name="cashMatchVerifiedOn"
            label="Cash match verified on"
            type="date"
            value={r.cash_match_verified_on}
          />
          <Text
            name="capacityVerifiedBy"
            label="Capacity verified by"
            value={r.capacity_verified_by}
          />
          <Text
            name="capacityVerifiedOn"
            label="Capacity verified on"
            type="date"
            value={r.capacity_verified_on}
          />
          <Area
            name="risks"
            label={t("brief.risks")}
            hint={t("brief.risksHint")}
            value={r?.risks}
          />
          <Choice
            name="recommendation"
            label={t("brief.recommendation")}
            value={r?.recommendation}
            options={[
              ["go", t("brief.rec.go")],
              ["no_go", t("brief.rec.no_go")],
              ["go_conditional", t("brief.rec.go_conditional")],
            ]}
          />
          <Text
            name="recommendationReason"
            label={t("brief.reason")}
            value={r?.recommendation_reason}
          />
          <Area name="condition" label={t("brief.condition")} value={r?.condition} />

          <div className="bg-[var(--color-accent-soft)] px-4 py-3 sm:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wide">{t("brief.leadership")}</p>
          </div>
          <Choice
            name="decision"
            label={t("brief.decision")}
            value={r?.decision ?? "pending"}
            options={[
              ["pending", t("brief.option.pending")],
              ["go", t("brief.decision.go")],
              ["no_go", t("brief.decision.no_go")],
              ["go_conditional", t("brief.decision.go_conditional")],
            ]}
          />
          <Text name="decidedBy" label={t("brief.approvedBy")} value={r?.decided_by} />
          <Text
            name="decisionReason"
            label={t("brief.decisionReason")}
            value={r?.decision_reason}
          />
          <Check name="conditionMet" label={t("brief.conditionMet")} value={r?.condition_met} />

          <div className="bg-[var(--color-surface)] px-4 py-3 sm:col-span-2">
            <button
              type="submit"
              disabled={saving || locked}
              data-testid="save-brief"
              className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {saving ? t("brief.saving") : locked ? t("brief.locked") : t("brief.save")}
            </button>
            {r.decided_at && (
              <span
                data-testid="decision-record"
                className="ml-3 text-xs text-[var(--color-ink-soft)]"
              >
                {t("brief.decided", {
                  date: new Date(r.decided_at) // English keeps the browser's default format, as before.
                    .toLocaleDateString(language === "en" ? undefined : locale),
                })}
                {r.decided_by ? t("brief.approver", { name: r.decided_by }) : ""}
                {r.recorder?.email ? t("brief.recordedBy", { email: r.recorder.email }) : ""}
              </span>
            )}
            {!row && (
              <p className="mt-2 text-xs text-[var(--color-ink-soft)]">{t("brief.prefilled")}</p>
            )}
          </div>
        </form>
      )}

      {(row || ready) && (
        <BudgetBuilder
          clientId={clientId}
          grantId={grantId}
          currency={prefill.currency}
          amountMin={prefill.amountMin ?? null}
          amountMax={prefill.amountMax}
          costSharePercent={costSharePercent}
          inKindCapPercent={inKindCapPercent}
          locked={locked}
          onUseTotals={applyBudgetTotals}
        />
      )}

      {!gate.allowed && (
        <p
          data-testid="drafting-locked"
          className="mt-3 rounded-md border border-[var(--color-rule)] bg-[var(--color-accent-soft)] p-3 text-sm"
        >
          {gate.reason}
        </p>
      )}
      {message && <p className="mt-2 text-sm text-[var(--color-ink-soft)]">{message}</p>}
      {failure && (
        <p role="alert" className="mt-2 text-sm text-[var(--color-ineligible)]">
          {failure}
        </p>
      )}
    </section>
  );
}

/**
 * Paper only. Portalled to <body> because the proposal screen's own print
 * export hides its whole <main>; `html[data-print="brief"]` (styles.css) then
 * prints this alone and nothing else.
 */
function PrintedBrief({ doc }: { doc: BriefDocument }) {
  return (
    <div aria-hidden="true" className="print-brief hidden text-sm text-black">
      <h1 className="text-lg font-semibold">Opportunity Brief — {doc.title}</h1>
      {!doc.saved && <p className="mt-1 italic">Draft: pre-filled from the call, not yet saved.</p>}
      {doc.sections.map((section) => (
        <section key={section.heading} className="mt-3 break-inside-avoid">
          <h2 className="border-b border-black pb-0.5 text-sm font-semibold">{section.heading}</h2>
          <dl className="mt-1 grid grid-cols-[11rem_1fr] gap-x-3 gap-y-0.5 text-xs">
            {section.rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="font-medium">{label}</dt>
                <dd className="whitespace-pre-wrap break-words">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

const inputClass =
  "mt-1 w-full rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1.5 text-sm";

function Label({ name, label }: { name: string; label: string }) {
  return (
    <label
      htmlFor={`brief-${name}`}
      className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]"
    >
      {label}
    </label>
  );
}

function Text({
  name,
  label,
  value,
  type = "text",
}: {
  name: string;
  label: string;
  value: unknown;
  type?: "text" | "date";
}) {
  return (
    <div className="bg-[var(--color-surface)] px-4 py-3">
      <Label name={name} label={label} />
      <input
        id={`brief-${name}`}
        name={name}
        type={type}
        defaultValue={value == null ? "" : String(value)}
        className={inputClass}
      />
    </div>
  );
}

function Area({
  name,
  label,
  hint,
  value,
}: {
  name: string;
  label: string;
  hint?: string;
  value: string | null | undefined;
}) {
  return (
    <div className="bg-[var(--color-surface)] px-4 py-3 sm:col-span-2">
      <Label name={name} label={label} />
      <textarea
        id={`brief-${name}`}
        name={name}
        rows={2}
        placeholder={hint}
        defaultValue={value ?? ""}
        className={inputClass}
      />
    </div>
  );
}

function Choice({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: string | null | undefined;
  options: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <div className="bg-[var(--color-surface)] px-4 py-3">
      <Label name={name} label={label} />
      <select id={`brief-${name}`} name={name} defaultValue={value ?? ""} className={inputClass}>
        {name !== "decision" && <option value="">—</option>}
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

function Check({
  name,
  label,
  value,
}: {
  name: string;
  label: string;
  value: boolean | null | undefined;
}) {
  return (
    <div className="bg-[var(--color-surface)] px-4 py-3">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name={name} defaultChecked={!!value} className="mt-1" />
        <span>{label}</span>
      </label>
    </div>
  );
}
