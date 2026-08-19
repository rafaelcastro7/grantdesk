import { createFileRoute, Link } from "@tanstack/react-router";
import { errorMessage } from "@/lib/error-message";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { extractProfile } from "@/server/profile.functions";
import { assessProfile, nextGap, type ProfileFields } from "@/lib/profile-completeness";

export const Route = createFileRoute("/clients/$clientId")({ component: ClientDetail });

type ClientRow = { id: string; name: string; website: string | null };

type StoredAnswer = {
  id: string;
  label: string;
  content: string;
  times_used: number;
  last_used_at: string | null;
};

type StoredProfile = {
  sectors: string[] | null;
  jurisdictions: string[] | null;
  stage: string | null;
  annual_budget: number | null;
  capabilities: string | null;
  beneficiaries: string | null;
  reviewed_at: string | null;
};

function toFields(profile: StoredProfile | null): ProfileFields {
  return {
    sectors: profile?.sectors ?? [],
    jurisdictions: profile?.jurisdictions ?? [],
    stage: profile?.stage ?? null,
    annualBudget: profile?.annual_budget ?? null,
    capabilities: profile?.capabilities ?? null,
    beneficiaries: profile?.beneficiaries ?? null,
  };
}

function ClientDetail() {
  const { clientId } = Route.useParams();
  const runExtraction = useServerFn(extractProfile);

  const [client, setClient] = useState<ClientRow | null>(null);
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [answers, setAnswers] = useState<StoredAnswer[] | null>(null);

  const load = useCallback(async () => {
    const { data: clientRow, error: clientError } = await supabase()
      .from("clients")
      .select("id, name, website")
      .eq("id", clientId)
      .maybeSingle();
    if (clientError) {
      setError(clientError.message);
      return;
    }
    setClient(clientRow as ClientRow | null);
    if (clientRow?.website && !sourceUrl) setSourceUrl(clientRow.website as string);

    const { data: profileRow } = await supabase()
      .from("client_profiles")
      .select(
        "sectors, jurisdictions, stage, annual_budget, capabilities, beneficiaries, reviewed_at",
      )
      .eq("client_id", clientId)
      .maybeSingle();
    setProfile((profileRow as StoredProfile | null) ?? null);

    const { data: answerRows } = await supabase()
      .from("answer_library")
      .select("id, label, content, times_used, last_used_at")
      .eq("client_id", clientId)
      .order("times_used", { ascending: false })
      .order("updated_at", { ascending: false });
    setAnswers((answerRows ?? []) as StoredAnswer[]);
  }, [clientId, sourceUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  async function fillFromWebsite(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await runExtraction({ data: { url: sourceUrl.trim() } });
      if (!result.ok) throw new Error(result.error);

      const { profile: extracted, provenance } = result;
      const { error: upsertError } = await supabase()
        .from("client_profiles")
        .upsert(
          {
            client_id: clientId,
            sectors: extracted.sectors,
            jurisdictions: extracted.jurisdictions,
            stage: extracted.stage,
            annual_budget: extracted.annualBudget,
            currency: extracted.currency,
            capabilities: extracted.capabilities,
            beneficiaries: extracted.beneficiaries,
            // Provenance, not decoration: a profile that cannot say why it
            // claims "Ontario" is one nobody can trust or correct.
            extracted_from: [provenance],
          },
          { onConflict: "client_id" },
        );
      if (upsertError) throw upsertError;

      setNote(
        `Read from ${provenance.source} via ${provenance.model}. Check it before relying on it.`,
      );
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Saved from FormData rather than controlled state, for the reason Phase 1
   * found the hard way: server-rendered inputs accept typing before React
   * binds its handlers, and a controlled form submits whatever empty strings
   * its state still holds.
   */
  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const list = (key: string) =>
      text(key)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const budget = Number(text("annualBudget").replace(/[,\s$]/g, ""));
      const { error: saveError } = await supabase()
        .from("client_profiles")
        .upsert(
          {
            client_id: clientId,
            sectors: list("sectors"),
            jurisdictions: list("jurisdictions").map((j) => j.toUpperCase()),
            stage: text("stage") || null,
            // An unreadable number is left unset rather than stored as zero,
            // which the scale rule would read as a real budget of nothing.
            annual_budget: Number.isFinite(budget) && budget > 0 ? budget : null,
            capabilities: text("capabilities") || null,
            beneficiaries: text("beneficiaries") || null,
            // A human just confirmed this, which is exactly what the field means.
            reviewed_at: new Date().toISOString(),
          },
          { onConflict: "client_id" },
        );
      if (saveError) throw saveError;
      setNote("Profile saved.");
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Remove an answer from the reuse pool.
   *
   * This is the reason the library needed a surface at all. A saved answer is
   * not a note — it is fed to the model as approved fact on every future draft
   * for this client, so one wrong figure kept here quietly reappears in
   * proposal after proposal. Being able to see them is useful; being able to
   * delete one is the point.
   */
  async function forgetAnswer(answer: StoredAnswer) {
    setError(null);
    setNote(null);
    setAnswers((current) => (current ?? []).filter((a) => a.id !== answer.id));
    try {
      const { error: deleteError } = await supabase()
        .from("answer_library")
        .delete()
        .eq("id", answer.id);
      if (deleteError) throw deleteError;
      setNote(`Removed "${answer.label}". Future drafts will not use it.`);
    } catch (caught) {
      await load();
      setError(errorMessage(caught));
    }
  }

  const fields = toFields(profile);
  const completeness = assessProfile(fields);
  const gap = nextGap(completeness);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link to="/clients" className="text-sm text-[var(--color-accent)]">
        ← All clients
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">{client?.name ?? "Client"}</h1>

      <section className="mt-8 rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-4">
        <h2 className="text-sm font-semibold">Fill the profile from their website</h2>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          Paste an About or Programs page. We read what it says and never invent what it does not.
        </p>
        <form onSubmit={fillFromWebsite} className="mt-3 flex flex-wrap gap-2">
          <input
            name="sourceUrl"
            type="url"
            required
            aria-label="Page to read"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://example.org/about"
            className="min-w-64 flex-1 rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 py-2"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Reading…" : "Read the page"}
          </button>
        </form>
        {note && <p className="mt-3 text-sm text-[var(--color-ink-soft)]">{note}</p>}
        {error && (
          <p role="alert" className="mt-3 text-sm text-[var(--color-ineligible)]">
            {error}
          </p>
        )}
      </section>

      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Profile</h2>
          <span data-testid="completeness" className="font-mono text-sm tabular-nums">
            {completeness.score}/100
          </span>
        </div>

        {/* Editable, because the page above can always fail — a site that
            renders through script, a page that moved, a provider that is down.
            A product whose profile can only be filled by a model reading a
            website has no answer for any of those, and the gap prompt below
            would be a question with nowhere to answer it. */}
        <form
          onSubmit={saveProfile}
          data-testid="profile-form"
          className="mt-3 grid gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)] sm:grid-cols-2"
        >
          <EditField
            name="jurisdictions"
            label="Operates in"
            hint="Country or province codes, comma separated — CA, CA-ON, US"
            defaultValue={(fields.jurisdictions ?? []).join(", ")}
          />
          <EditField
            name="sectors"
            label="Sectors"
            hint="Comma separated — environment, education"
            defaultValue={(fields.sectors ?? []).join(", ")}
          />
          <EditField
            name="stage"
            label="Stage"
            hint="nonprofit, charity, startup, university…"
            defaultValue={fields.stage ?? ""}
          />
          <EditField
            name="annualBudget"
            label="Annual budget"
            hint="Approximate, in their own currency"
            defaultValue={fields.annualBudget ? String(fields.annualBudget) : ""}
          />
          <EditField
            name="capabilities"
            label="Track record"
            defaultValue={fields.capabilities ?? ""}
          />
          <EditField
            name="beneficiaries"
            label="Who benefits"
            defaultValue={fields.beneficiaries ?? ""}
          />

          <div className="bg-[var(--color-surface)] px-4 py-3 sm:col-span-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save profile"}
            </button>
          </div>
        </form>

        {/* One concrete question, not a list of six gaps: a list gets ignored. */}
        {gap ? (
          <p
            data-testid="next-gap"
            className="mt-4 rounded-md border border-[var(--color-rule)] bg-[var(--color-accent-soft)] p-3 text-sm"
          >
            {gap.prompt}
          </p>
        ) : (
          <p className="mt-4 text-sm text-[var(--color-eligible)]">
            Complete. This client is ready to match against.
          </p>
        )}

        <p data-testid="can-match" className="mt-3 text-sm text-[var(--color-ink-soft)]">
          {completeness.canMatch
            ? "Ready to match."
            : "Matching is off until the required fields are filled — otherwise we cannot rule out what this client is ineligible for."}
        </p>

        {/* The link appears only once matching would actually mean something.
            Offering it earlier would produce a page of results the rules cannot
            stand behind, which is the failure mode this product is built against. */}
        {completeness.canMatch && (
          <Link
            to="/clients/$clientId/matches"
            params={{ clientId }}
            data-testid="to-matches"
            className="mt-4 inline-block rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white"
          >
            Find what they can apply for →
          </Link>
        )}
      </section>

      {answers !== null && answers.length > 0 && (
        <section className="mt-10" data-testid="answer-library">
          <h2 className="text-sm font-semibold">Answers kept for this client</h2>
          <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-soft)]">
            Every draft for this client is written from these. They are approved facts, not notes —
            so anything wrong in here reappears in proposal after proposal until it is removed.
          </p>
          <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
            {answers.map((answer) => (
              <li key={answer.id} className="bg-[var(--color-surface)] px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium">{answer.label}</span>
                  <span className="shrink-0 text-xs text-[var(--color-ink-soft)]">
                    {answer.times_used === 0
                      ? "not used yet"
                      : `used ${answer.times_used} time${answer.times_used === 1 ? "" : "s"}`}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-[var(--color-ink-soft)]">
                  {answer.content}
                </p>
                <button
                  type="button"
                  onClick={() => forgetAnswer(answer)}
                  data-testid="forget-answer"
                  className="mt-2 text-xs text-[var(--color-ineligible)]"
                >
                  Remove from future drafts
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function EditField({
  name,
  label,
  hint,
  defaultValue,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue: string;
}) {
  return (
    <div className="bg-[var(--color-surface)] px-4 py-3">
      <label
        htmlFor={`profile-${name}`}
        className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]"
      >
        {label}
      </label>
      <input
        id={`profile-${name}`}
        name={name}
        // Keyed on the stored value so a fresh extraction replaces what the
        // field shows; an uncontrolled input otherwise keeps its first value
        // forever and quietly saves stale text back over the new profile.
        key={defaultValue}
        defaultValue={defaultValue}
        placeholder={hint}
        className="mt-1 w-full rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1.5 text-sm"
      />
    </div>
  );
}
