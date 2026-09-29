import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { errorMessage } from "@/lib/error-message";
import { draftingGate, fromRow, type Decision, type DraftingGate } from "@/lib/go-decision";

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
};

const COLUMNS =
  "role, role_other, intake, application_structure, strategic_angle, mandatory_components, " +
  "request_amount, net_revenue, match_required, in_kind_cap, cash_match_confirmed, risks, " +
  "recommendation, recommendation_reason, condition, decision, condition_met, decided_by, " +
  "decision_reason, decided_at";

const DECISION_LABEL: Record<Decision, string> = {
  pending: "Awaiting leadership decision",
  go: "GO",
  no_go: "NO-GO",
  go_conditional: "GO-CONDITIONAL",
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
}: {
  clientId: string;
  grantId: string;
  onGate: (gate: DraftingGate) => void;
}) {
  const [row, setRow] = useState<BriefRow | null>(null);
  const [required, setRequired] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data, error }, { data: policy, error: policyError }] = await Promise.all([
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
    ]);
    if (error || policyError) {
      setFailure((error ?? policyError)!.message);
      return;
    }
    const found = (data as unknown as BriefRow | null) ?? null;
    const mustDecide = !!(policy as { requires_go_decision?: boolean } | null)
      ?.requires_go_decision;
    setRow(found);
    setRequired(mustDecide);
    setLoaded(true);
    onGate(draftingGate(fromRow(found), mustDecide));
  }, [clientId, grantId, onGate]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim() || null;
    const money = (key: string) => {
      const value = Number(String(form.get(key) ?? "").replace(/[,\s$]/g, ""));
      return String(form.get(key) ?? "").trim() && Number.isFinite(value) ? value : null;
    };
    const decision = (text("decision") ?? "pending") as Decision;

    setSaving(true);
    setMessage(null);
    setFailure(null);
    try {
      const { error } = await supabase()
        .from("opportunity_decisions")
        .upsert(
          {
            client_id: clientId,
            grant_id: grantId,
            role: text("role"),
            role_other: text("roleOther"),
            intake: text("intake"),
            application_structure: text("applicationStructure"),
            strategic_angle: text("strategicAngle"),
            mandatory_components: text("mandatoryComponents"),
            request_amount: money("requestAmount"),
            net_revenue: money("netRevenue"),
            match_required: money("matchRequired"),
            in_kind_cap: money("inKindCap"),
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
          },
          { onConflict: "client_id, grant_id" },
        );
      if (error) throw error;
      await load();
      setMessage(decision === "pending" ? "Brief saved." : "Brief and decision recorded.");
    } catch (caught) {
      const text = errorMessage(caught);
      setFailure(
        /decided_by/.test(text) || /check constraint/.test(text)
          ? "A decision needs the approver's name, and a go-conditional needs its condition written out."
          : text,
      );
    } finally {
      setSaving(false);
    }
  }

  if (!loaded && !failure) return null;
  const gate = draftingGate(fromRow(row), required);
  const r = row;
  const k = r?.decided_at ?? "new";

  return (
    <section className="mt-10" data-testid="opportunity-brief">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Opportunity Brief and go / no-go</h2>
        <span
          data-testid="go-decision"
          className={`text-xs font-semibold uppercase tracking-wide ${
            gate.allowed ? "text-[var(--color-eligible)]" : "text-[var(--color-needs-input)]"
          }`}
        >
          {DECISION_LABEL[r?.decision ?? "pending"]}
        </span>
      </div>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
        {required
          ? "One page for leadership. This client's policy: nothing is drafted until a decision is recorded here."
          : "One page for whoever signs off. Optional for this client — drafting is not locked on it."}
      </p>

      <form
        key={k}
        onSubmit={save}
        className="mt-3 grid gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)] sm:grid-cols-2"
      >
        <Choice
          name="role"
          label="Role"
          value={r?.role}
          options={[
            ["lead", "Lead applicant"],
            ["funded_partner", "Funded partner"],
            ["other", "Other"],
          ]}
        />
        <Text name="roleOther" label="Other role (specify)" value={r?.role_other} />
        <Choice
          name="intake"
          label="Intake"
          value={r?.intake}
          options={[
            ["fixed", "Fixed deadline"],
            ["rolling", "Rolling"],
          ]}
        />
        <Choice
          name="applicationStructure"
          label="Application structure"
          value={r?.application_structure}
          options={[
            ["one_stage", "One-stage"],
            ["two_stage", "Two-stage (EOI first)"],
          ]}
        />
        <Area
          name="strategicAngle"
          label="Strategic angle"
          hint="Which capability this leverages, and what the client gains"
          value={r?.strategic_angle}
        />
        <Area
          name="mandatoryComponents"
          label="Mandatory components"
          hint="Every required study, deliverable or partner type — the guide's exact words"
          value={r?.mandatory_components}
        />
        <Text name="requestAmount" label="Request amount ($)" value={r?.request_amount} />
        <Text name="netRevenue" label="Net revenue ($)" value={r?.net_revenue} />
        <Text name="matchRequired" label="Match required ($)" value={r?.match_required} />
        <Text name="inKindCap" label="In-kind cap ($)" value={r?.in_kind_cap} />
        <Check
          name="cashMatchConfirmed"
          label="Whoever controls the budget has confirmed any cash match can be covered"
          value={r?.cash_match_confirmed}
        />
        <Area
          name="risks"
          label="Risks and unknowns"
          hint="Eligibility ambiguities, capacity, open questions, partner dependencies"
          value={r?.risks}
        />
        <Choice
          name="recommendation"
          label="Recommendation"
          value={r?.recommendation}
          options={[
            ["go", "Go"],
            ["no_go", "No-go"],
            ["go_conditional", "Go-conditional"],
          ]}
        />
        <Text name="recommendationReason" label="Reason" value={r?.recommendation_reason} />
        <Area name="condition" label="Condition (if go-conditional)" value={r?.condition} />

        <div className="bg-[var(--color-accent-soft)] px-4 py-3 sm:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-wide">Leadership decision</p>
        </div>
        <Choice
          name="decision"
          label="Decision"
          value={r?.decision ?? "pending"}
          options={[
            ["pending", "Pending"],
            ["go", "GO"],
            ["no_go", "NO-GO"],
            ["go_conditional", "GO-CONDITIONAL"],
          ]}
        />
        <Text name="decidedBy" label="Approved by" value={r?.decided_by} />
        <Text name="decisionReason" label="Decision reason" value={r?.decision_reason} />
        <Check
          name="conditionMet"
          label="Condition confirmed met with leadership"
          value={r?.condition_met}
        />

        <div className="bg-[var(--color-surface)] px-4 py-3 sm:col-span-2">
          <button
            type="submit"
            disabled={saving}
            data-testid="save-brief"
            className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save brief"}
          </button>
          {r?.decided_at && (
            <span className="ml-3 text-xs text-[var(--color-ink-soft)]">
              Decided {new Date(r.decided_at).toLocaleDateString()} by {r.decided_by}
            </span>
          )}
        </div>
      </form>

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
