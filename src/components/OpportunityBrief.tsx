import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { errorMessage } from "@/lib/error-message";
import { draftingGate, fromRow, type Decision, type DraftingGate } from "@/lib/go-decision";
import { parseMoney } from "@/lib/parse-money";
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
  updated_at: string | null;
  /** The signed-in account that recorded the decision, set by the database. */
  recorder: { email: string } | null;
};

const COLUMNS =
  "role, role_other, intake, application_structure, strategic_angle, mandatory_components, " +
  "request_amount, net_revenue, match_required, in_kind_cap, cash_match_confirmed, risks, " +
  "recommendation, recommendation_reason, condition, decision, condition_met, decided_by, " +
  "decision_reason, decided_at, updated_at, recorder:consultants!opportunity_decisions_decided_by_user_fkey(email)";

export type BriefPrefill = {
  deadline: string | null;
  amountMax: number | null;
  currency: string | null;
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
  locked = false,
  ready = true,
}: {
  clientId: string;
  grantId: string;
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

  return (
    <section className="mt-10" data-testid="opportunity-brief">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{t("brief.title")}</h2>
        <span
          data-testid="go-decision"
          className={`text-xs font-semibold uppercase tracking-wide ${
            gate.allowed ? "text-[var(--color-eligible)]" : "text-[var(--color-needs-input)]"
          }`}
        >
          {t(DECISION_LABEL[r?.decision ?? "pending"])}
        </span>
      </div>
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

function Text({ name, label, value }: { name: string; label: string; value: unknown }) {
  return (
    <div className="bg-[var(--color-surface)] px-4 py-3">
      <Label name={name} label={label} />
      <input
        id={`brief-${name}`}
        name={name}
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
