import { createFileRoute, Link } from "@tanstack/react-router";
import { useAction } from "@/lib/use-action";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { accessToken } from "@/lib/session";
import { parseMoney } from "@/lib/parse-money";
import { useRequireSession } from "@/lib/use-require-session";
import { useDocumentTitle } from "@/lib/use-document-title";
import { extractProfile } from "@/server/profile.functions";
import { assessProfile, nextGap, type ProfileFields } from "@/lib/profile-completeness";
import { PipelineLog } from "@/components/PipelineLog";
import { DocumentRegister } from "@/components/DocumentRegister";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/clients/$clientId")({ component: ClientDetail });

type ClientRow = { id: string; name: string; website: string | null; consultant_id: string };

type TeamMember = {
  user_id: string;
  added_at: string;
  consultants: { email: string; display_name: string | null } | null;
};

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
  lead_time_weeks: number | null;
  funded_partner_pathway: boolean | null;
  partner_lead_time_weeks: number | null;
  capability_domains: string[] | null;
  requires_go_decision: boolean | null;
  currency: string | null;
  draft_language: string | null;
};

function toFields(profile: StoredProfile | null): ProfileFields {
  return {
    sectors: profile?.sectors ?? [],
    jurisdictions: profile?.jurisdictions ?? [],
    stage: profile?.stage ?? null,
    annualBudget: profile?.annual_budget ?? null,
    capabilities: profile?.capabilities ?? null,
    beneficiaries: profile?.beneficiaries ?? null,
    leadTimeWeeks: profile?.lead_time_weeks ?? null,
  };
}

function ClientDetail() {
  useRequireSession();
  const { clientId } = Route.useParams();
  const runExtraction = useServerFn(extractProfile);
  const { t } = useI18n();

  const [client, setClient] = useState<ClientRow | null>(null);
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const { busy, error, note, run, setError } = useAction();
  const [answers, setAnswers] = useState<StoredAnswer[] | null>(null);
  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [teammateEmail, setTeammateEmail] = useState("");

  const load = useCallback(async () => {
    // Fetched together rather than one after another. Sequentially, each
    // `await` hands control back before the next query starts, and the
    // auto-read effect below runs on every one of those in-between renders —
    // it saw sourceUrl already set from the client row while profile was
    // still sitting at its initial null, genuinely indistinguishable from
    // "no profile exists yet", and fired a real extraction call against a
    // client that already had one. Resolving all four together means every
    // field lands in the same render, so that render is never half-true.
    const [{ data: clientRow, error: clientError }, teamResult, profileResult, answersResult] =
      await Promise.all([
        supabase()
          .from("clients")
          .select("id, name, website, consultant_id")
          .eq("id", clientId)
          .maybeSingle(),
        // client_team_members has two foreign keys into consultants (user_id
        // and added_by), so "consultants(...)" alone is ambiguous to
        // PostgREST — it errors, and errors on a nested-select like this had
        // no error check here to catch it, so the team looked empty rather
        // than failing loudly. Naming the constraint resolves it.
        supabase()
          .from("client_team_members")
          .select(
            "user_id, added_at, consultants!client_team_members_user_id_fkey(email, display_name)",
          )
          .eq("client_id", clientId)
          .order("added_at", { ascending: true }),
        supabase()
          .from("client_profiles")
          .select(
            "sectors, jurisdictions, stage, annual_budget, capabilities, beneficiaries, " +
              "reviewed_at, lead_time_weeks, funded_partner_pathway, partner_lead_time_weeks, " +
              "capability_domains, requires_go_decision, currency, draft_language",
          )
          .eq("client_id", clientId)
          .maybeSingle(),
        supabase()
          .from("answer_library")
          .select("id, label, content, times_used, last_used_at")
          .eq("client_id", clientId)
          .order("times_used", { ascending: false })
          .order("updated_at", { ascending: false }),
      ]);

    if (clientError) {
      setError(clientError.message);
      return;
    }

    // Committed regardless of whether the team query below succeeded — all
    // four queries ran in the same Promise.all, so a transient failure on
    // just the team join (the ambiguous-FK class of error the comment above
    // already names) used to return here before any of these ran, blanking
    // the client name, profile and answer library too even though they had
    // already come back fine.
    setClient(clientRow as ClientRow | null);
    // A failed profile read must not look like "no profile yet" — that is what
    // triggers an automatic re-extraction over a profile that exists.
    if (profileResult.error) {
      setError(profileResult.error.message);
      return;
    }
    if (clientRow?.website) setSourceUrl((current) => current || (clientRow.website as string));
    setProfile((profileResult.data as StoredProfile | null) ?? null);
    if (answersResult.error) setError(answersResult.error.message);
    else setAnswers((answersResult.data ?? []) as StoredAnswer[]);

    if (teamResult.error) {
      setError(teamResult.error.message);
      return;
    }
    setTeam((teamResult.data ?? []) as unknown as TeamMember[]);
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void supabase()
      .auth.getUser()
      .then(({ data }) => setMyId(data.user?.id ?? null));
  }, []);

  /**
   * Arrived here from the matches page's "one fact decides it" link, naming
   * exactly which field to fill in — but a hash-only jump just scrolls, and
   * gives no visual signal for which of seven identical-looking fields is
   * the one the consultant actually came here to fix. Focusing it is the
   * difference between "here's the form" and "here's the field".
   */
  useEffect(() => {
    if (profile === null) return;
    const id = window.location.hash.slice(1);
    if (!id) return;
    document.getElementById(id)?.focus();
  }, [profile]);

  /**
   * Run it without being asked, once, the same idiom the matches page uses
   * for the same reason.
   *
   * A website was just typed into the "Add client" form one screen ago. This
   * screen was then showing that same URL back, already filled in, sitting
   * next to a button whose only job was to do the thing the consultant had
   * just told the app to do. That is not a confirmation step — a wrong URL or
   * an unreadable page is caught by the profile staying empty, not by a
   * second click — so it fires here instead, and the button stays as "Read
   * the page again" for a real re-read after the site changes.
   */
  const autoRead = useRef(false);
  /** Set on the first keystroke in the profile form. */
  const touched = useRef(false);
  useEffect(() => {
    if (autoRead.current || touched.current || profile !== null || !sourceUrl || busy) return;
    autoRead.current = true;
    void fillFromWebsite(undefined, { auto: true });
    // `run`/`fillFromWebsite` are stable enough for this one-shot; re-running
    // on their identity would defeat the guard it depends on.
  }, [profile, sourceUrl, busy]);

  /**
   * Adding a colleague to a shared client, by email.
   *
   * Looked up rather than invited: find_consultant_by_email() only resolves
   * an id for someone who already has a GrantDesk account, and says so
   * plainly when it doesn't — building a real invitation flow (send mail to
   * someone with no account yet, hold a pending grant until they sign up) is
   * a materially bigger feature nobody asked for yet.
   */
  async function addTeammate(event: React.FormEvent) {
    event.preventDefault();
    const email = teammateEmail.trim();
    if (!email) return;

    await run("team", async () => {
      const { data: foundId, error: lookupError } = await supabase().rpc(
        "find_consultant_by_email",
        { target_email: email },
      );
      if (lookupError) throw lookupError;
      if (!foundId) {
        throw new Error(t("clients.noAccount", { email }));
      }
      if (foundId === client?.consultant_id) {
        throw new Error(t("clients.alreadyOwner", { email }));
      }
      if (foundId === myId) {
        throw new Error(t("clients.ownAccount"));
      }

      const { error: insertError } = await supabase()
        .from("client_team_members")
        .insert({ client_id: clientId, user_id: foundId, added_by: myId });
      if (insertError) {
        if (insertError.code === "23505") throw new Error(t("clients.alreadyMember", { email }));
        throw insertError;
      }
      setTeammateEmail("");
      await load();
      return t("clients.added", { email });
    });
  }

  async function removeTeammate(member: TeamMember) {
    const label =
      member.consultants?.display_name || member.consultants?.email || t("clients.thisPerson");
    const leaving = member.user_id === myId;
    // Only for removing someone else — the list re-renders in added_at
    // order, not a stable screen position, so a click meant for one row can
    // land on the row above or below it after the state updates. A colleague
    // cut off from a client's live drafts and matches by that misclick has
    // no undo; leaving yourself is the one case where a mistaken click is
    // still trivially reversible by whoever owns the client re-adding you.
    if (!leaving && !window.confirm(t("clients.confirmRemove", { label }))) return;
    setTeam((current) => (current ?? []).filter((m) => m.user_id !== member.user_id));
    await run("team", async () => {
      const { error: deleteError } = await supabase()
        .from("client_team_members")
        .delete()
        .eq("client_id", clientId)
        .eq("user_id", member.user_id);
      if (deleteError) {
        await load();
        throw deleteError;
      }
      return leaving ? t("clients.left") : t("clients.removed", { label });
    });
  }

  async function fillFromWebsite(event?: React.FormEvent, options: { auto?: boolean } = {}) {
    event?.preventDefault();
    await run("extract", async () => {
      // The automatic read and a person typing into the form below it can now
      // run at the same time — that is the whole point of not making them
      // wait for each other. But the read is slow (a real fetch plus a model
      // call) and upsert() replaces the row wholesale, so if someone saves a
      // profile by hand while it is still in flight, an automatic read that
      // finishes afterward would silently overwrite what they just typed
      // with whatever a mostly-empty "About" page produced. A deliberate
      // "Read the page again" click should still always win — the person
      // asked for it — but the unsolicited first read never should, once
      // something else has already put a real profile in place.
      //
      // Checked before spending the fetch and the model call, not after —
      // load() fetching everything in one Promise.all should already stop
      // this effect from firing at all once a profile exists, but that made
      // this check redundant, not wrong to keep: a second, independent guard
      // that happens to also save the wasted call if the first one is ever
      // defeated by some future change to load()'s timing.
      // The person started typing: their words win over an unsolicited read.
      if (options.auto && touched.current) {
        return t("clients.skippedTyping");
      }
      if (options.auto) {
        const { data: existing } = await supabase()
          .from("client_profiles")
          .select("client_id")
          .eq("client_id", clientId)
          .maybeSingle();
        if (existing) return t("clients.skippedExisting");
      }

      const result = await runExtraction({
        data: { url: sourceUrl.trim(), accessToken: await accessToken() },
      });
      if (!result.ok) throw new Error(result.error);
      // Typing began while the page was being read: saving the extraction now
      // would remount the fields and throw that typing away.
      if (options.auto && touched.current) {
        return t("clients.readButTyping");
      }

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
      await load();
      // The chain falls through to a small local model when the hosted ones
      // are unreachable. Naming the model is not the same as saying what it
      // means — "ollama/phi4-mini" tells a consultant nothing about how hard
      // to check what it just wrote into their client's profile.
      return provenance.model.startsWith("ollama")
        ? t("clients.readLocal", { source: provenance.source })
        : t("clients.readVia", { source: provenance.source, model: provenance.model });
    });
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

    await run("save", async () => {
      const budget = parseMoney(text("annualBudget"));
      // Weeks: empty means "not set"; anything else must be a whole 1–52, or
      // the save is refused with the reason instead of storing nothing.
      const weeks = (key: string, label: string) => {
        const raw = text(key);
        if (!raw) return null;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 52) {
          throw new Error(t("clients.weeksInvalid", { label }));
        }
        return n;
      };
      if (Number.isNaN(budget)) {
        throw new Error(t("clients.budgetInvalid"));
      }
      const leadTime = weeks("leadTimeWeeks", t("clients.weeksLeadTime"));
      const partnerLeadTime = weeks("partnerLeadTimeWeeks", t("clients.weeksPartnerLeadTime"));
      const currency = text("currency").toUpperCase() || null;
      const { error: saveError } = await supabase()
        .from("client_profiles")
        .upsert(
          {
            client_id: clientId,
            sectors: list("sectors"),
            jurisdictions: list("jurisdictions").map((j) => j.toUpperCase()),
            stage: text("stage") || null,
            annual_budget: budget && budget > 0 ? budget : null,
            currency,
            capabilities: text("capabilities") || null,
            beneficiaries: text("beneficiaries") || null,
            lead_time_weeks: leadTime,
            partner_lead_time_weeks: partnerLeadTime,
            funded_partner_pathway: form.get("fundedPartnerPathway") === "on",
            requires_go_decision: form.get("requiresGoDecision") === "on",
            capability_domains: list("capabilityDomains"),
            draft_language: text("draftLanguage") === "fr" ? "fr" : "en",
            // A human just confirmed this, which is exactly what the field means.
            reviewed_at: new Date().toISOString(),
          },
          { onConflict: "client_id" },
        );
      if (saveError) throw saveError;
      await load();
      return t("clients.profileSaved");
    });
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
    // Removed from view first: the row is gone the moment it is clicked, and
    // put back only if the delete actually fails.
    setAnswers((current) => (current ?? []).filter((a) => a.id !== answer.id));
    await run("forget", async () => {
      const { error: deleteError } = await supabase()
        .from("answer_library")
        .delete()
        .eq("id", answer.id);
      if (deleteError) {
        await load();
        throw deleteError;
      }
      return t("clients.forgotten", { label: answer.label });
    });
  }

  useDocumentTitle(client?.name, t("clients.client"));
  const fields = toFields(profile);
  const completeness = assessProfile(fields);
  const gap = nextGap(completeness);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link to="/clients" className="text-sm text-[var(--color-accent)]">
        {t("clients.back")}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        {client?.name ?? t("clients.client")}
      </h1>

      <section className="mt-8 rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-4">
        <h2 className="text-sm font-semibold">{t("clients.fillTitle")}</h2>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{t("clients.fillIntro")}</p>
        <form onSubmit={fillFromWebsite} className="mt-3 flex flex-wrap gap-2">
          <input
            name="sourceUrl"
            type="url"
            required
            aria-label={t("clients.pageToRead")}
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://example.org/about"
            className="min-w-64 flex-1 rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 py-2"
          />
          <button
            type="submit"
            disabled={busy !== null}
            className="rounded-md bg-[var(--color-accent-strong)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy === "extract"
              ? t("clients.reading")
              : profile !== null
                ? t("clients.readAgain")
                : t("clients.read")}
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
          <h2 className="text-sm font-semibold">{t("clients.profile")}</h2>
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
          onInput={() => {
            touched.current = true;
          }}
          data-testid="profile-form"
          aria-busy={busy === "extract"}
          className="mt-3 grid gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)] sm:grid-cols-2"
        >
          {/* Editable while their site is read: the first keystroke makes the
              automatic read stand down, so nothing typed here is replaced. */}
          <fieldset className="contents">
            <EditField
              name="jurisdictions"
              label={t("clients.field.jurisdictions")}
              hint={t("clients.field.jurisdictionsHint")}
              defaultValue={(fields.jurisdictions ?? []).join(", ")}
            />
            <EditField
              name="sectors"
              label={t("clients.field.sectors")}
              hint={t("clients.field.sectorsHint")}
              defaultValue={(fields.sectors ?? []).join(", ")}
            />
            <EditField
              name="stage"
              label={t("clients.field.stage")}
              hint={t("clients.field.stageHint")}
              defaultValue={fields.stage ?? ""}
            />
            <EditField
              name="annualBudget"
              label={t("clients.field.annualBudget")}
              hint={t("clients.field.annualBudgetHint")}
              defaultValue={fields.annualBudget ? String(fields.annualBudget) : ""}
            />
            <EditField
              name="currency"
              label={t("clients.field.currency")}
              hint={t("clients.field.currencyHint")}
              defaultValue={profile?.currency ?? ""}
            />
            <EditField
              name="leadTimeWeeks"
              label={t("clients.field.leadTime")}
              hint={t("clients.field.leadTimeHint")}
              defaultValue={fields.leadTimeWeeks ? String(fields.leadTimeWeeks) : ""}
            />
            <EditField
              name="partnerLeadTimeWeeks"
              label={t("clients.field.partnerLeadTime")}
              hint={t("clients.field.partnerLeadTimeHint")}
              defaultValue={
                profile?.partner_lead_time_weeks ? String(profile.partner_lead_time_weeks) : ""
              }
            />
            <EditField
              name="capabilityDomains"
              label={t("clients.field.capabilityDomains")}
              hint={t("clients.field.capabilityDomainsHint")}
              defaultValue={(profile?.capability_domains ?? []).join(", ")}
            />
            <div className="bg-[var(--color-surface)] px-4 py-3">
              <label
                htmlFor="profile-draftLanguage"
                className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]"
              >
                {t("clients.field.draftLanguage")}
              </label>
              <select
                id="profile-draftLanguage"
                name="draftLanguage"
                data-testid="draft-language"
                key={profile?.draft_language ?? "en"}
                defaultValue={profile?.draft_language === "fr" ? "fr" : "en"}
                aria-describedby="profile-draftLanguage-hint"
                className="mt-1 w-full rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-2 py-1.5 text-sm"
              >
                <option value="en">English</option>
                <option value="fr">Français</option>
              </select>
              <p
                id="profile-draftLanguage-hint"
                className="mt-1 text-xs text-[var(--color-ink-soft)]"
              >
                {t("clients.field.draftLanguageHint")}
              </p>
            </div>
            <div className="bg-[var(--color-surface)] px-4 py-3 sm:col-span-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="fundedPartnerPathway"
                  key={String(profile?.funded_partner_pathway ?? false)}
                  defaultChecked={profile?.funded_partner_pathway ?? false}
                  className="mt-1"
                />
                <span>
                  {t("clients.fundedPartnerBefore")}
                  <strong>{t("clients.fundedPartnerStrong")}</strong>
                  {t("clients.fundedPartnerAfter")}
                </span>
              </label>
              <label className="mt-2 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="requiresGoDecision"
                  key={String(profile?.requires_go_decision ?? false)}
                  defaultChecked={profile?.requires_go_decision ?? false}
                  className="mt-1"
                />
                <span>
                  {t("clients.goDecisionBefore")}
                  <strong>{t("clients.goDecisionStrong")}</strong>
                  {t("clients.goDecisionAfter")}
                </span>
              </label>
            </div>
            <EditField
              name="capabilities"
              label={t("clients.field.capabilities")}
              defaultValue={fields.capabilities ?? ""}
            />
            <EditField
              name="beneficiaries"
              label={t("clients.field.beneficiaries")}
              defaultValue={fields.beneficiaries ?? ""}
            />

            <div className="bg-[var(--color-surface)] px-4 py-3 sm:col-span-2">
              <button
                type="submit"
                disabled={busy !== null}
                className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              >
                {busy === "save" ? t("clients.saving") : t("clients.saveProfile")}
              </button>
              {busy === "extract" && (
                <span className="ml-3 text-sm text-[var(--color-ink-soft)]" aria-live="polite">
                  {t("clients.readingSite")}
                </span>
              )}
            </div>
          </fieldset>
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
          <p className="mt-4 text-sm text-[var(--color-eligible)]">{t("clients.complete")}</p>
        )}

        <p data-testid="can-match" className="mt-3 text-sm text-[var(--color-ink-soft)]">
          {completeness.canMatch ? t("clients.readyToMatch") : t("clients.matchingOff")}
        </p>

        {/* The link appears only once matching would actually mean something.
            Offering it earlier would produce a page of results the rules cannot
            stand behind, which is the failure mode this product is built against. */}
        {completeness.canMatch && (
          <Link
            to="/clients/$clientId/matches"
            params={{ clientId }}
            data-testid="to-matches"
            className="mt-4 inline-block rounded-md bg-[var(--color-accent-strong)] px-4 py-2 text-sm font-medium text-white"
          >
            {t("clients.toMatches")}
          </Link>
        )}
      </section>

      <section className="mt-10" data-testid="team">
        <h2 className="text-sm font-semibold">{t("clients.teamTitle")}</h2>
        <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-soft)]">
          {t("clients.teamIntro")}
        </p>

        <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
          <li className="flex items-center justify-between bg-[var(--color-surface)] px-4 py-3 text-sm">
            <span>{client?.consultant_id === myId ? t("clients.you") : t("clients.theOwner")}</span>
            <span className="text-xs text-[var(--color-ink-soft)]">{t("clients.owner")}</span>
          </li>
          {(team ?? []).map((member) => (
            <li
              key={member.user_id}
              data-testid="team-member"
              className="flex items-center justify-between bg-[var(--color-surface)] px-4 py-3 text-sm"
            >
              <span>
                {member.user_id === myId
                  ? t("clients.you")
                  : member.consultants?.display_name ||
                    member.consultants?.email ||
                    t("clients.unknown")}
              </span>
              {/* Anyone may leave; only the owner may remove someone else — a
                  member who could remove other members could quietly narrow
                  who has access to material they didn't add. */}
              {(member.user_id === myId || client?.consultant_id === myId) && (
                <button
                  type="button"
                  onClick={() => removeTeammate(member)}
                  data-testid="remove-teammate"
                  className="text-xs text-[var(--color-ineligible)]"
                >
                  {member.user_id === myId ? t("clients.leave") : t("clients.remove")}
                </button>
              )}
            </li>
          ))}
        </ul>

        {client?.consultant_id === myId && (
          <form onSubmit={addTeammate} className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="email"
              name="teammateEmail"
              aria-label={t("clients.colleagueEmail")}
              value={teammateEmail}
              onChange={(event) => setTeammateEmail(event.target.value)}
              placeholder="colleague@yourfirm.com"
              className="min-w-64 flex-1 rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={busy !== null || !teammateEmail.trim()}
              data-testid="add-teammate"
              className="rounded-md border border-[var(--color-rule)] px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              {t("clients.addToClient")}
            </button>
          </form>
        )}
      </section>

      {answers !== null && answers.length > 0 && (
        <section className="mt-10" data-testid="answer-library">
          <h2 className="text-sm font-semibold">{t("clients.answersTitle")}</h2>
          <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-soft)]">
            {t("clients.answersIntro")}
          </p>
          <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
            {answers.map((answer) => (
              <li key={answer.id} className="bg-[var(--color-surface)] px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium">{answer.label}</span>
                  <span className="shrink-0 text-xs text-[var(--color-ink-soft)]">
                    {answer.times_used === 0
                      ? t("clients.notUsed")
                      : t(answer.times_used === 1 ? "clients.usedOne" : "clients.usedOther", {
                          count: answer.times_used,
                        })}
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
                  {t("clients.forget")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <DocumentRegister clientId={clientId} />

      <PipelineLog clientId={clientId} />
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
