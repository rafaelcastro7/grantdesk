import { createFileRoute, Link } from "@tanstack/react-router";
import { useAction } from "@/lib/use-action";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { extractProfile } from "@/server/profile.functions";
import { assessProfile, nextGap, type ProfileFields } from "@/lib/profile-completeness";
import { PipelineLog } from "@/components/PipelineLog";

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
  const { clientId } = Route.useParams();
  const runExtraction = useServerFn(extractProfile);

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
              "capability_domains, requires_go_decision",
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
    if (clientRow?.website && !sourceUrl) setSourceUrl(clientRow.website as string);
    setProfile((profileResult.data as StoredProfile | null) ?? null);
    setAnswers((answersResult.data ?? []) as StoredAnswer[]);

    if (teamResult.error) {
      setError(teamResult.error.message);
      return;
    }
    setTeam((teamResult.data ?? []) as unknown as TeamMember[]);
  }, [clientId, sourceUrl]);

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
  useEffect(() => {
    if (autoRead.current || profile !== null || !sourceUrl || busy) return;
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
        throw new Error(`No GrantDesk account uses ${email} yet — ask them to sign up first.`);
      }
      if (foundId === client?.consultant_id) {
        throw new Error(`${email} already owns this client.`);
      }
      if (foundId === myId) {
        throw new Error("That's your own account.");
      }

      const { error: insertError } = await supabase()
        .from("client_team_members")
        .insert({ client_id: clientId, user_id: foundId, added_by: myId });
      if (insertError) {
        if (insertError.code === "23505") throw new Error(`${email} is already on this team.`);
        throw insertError;
      }
      setTeammateEmail("");
      await load();
      return `Added ${email}. They'll see this client next time they sign in.`;
    });
  }

  async function removeTeammate(member: TeamMember) {
    const label = member.consultants?.display_name || member.consultants?.email || "this person";
    const leaving = member.user_id === myId;
    // Only for removing someone else — the list re-renders in added_at
    // order, not a stable screen position, so a click meant for one row can
    // land on the row above or below it after the state updates. A colleague
    // cut off from a client's live drafts and matches by that misclick has
    // no undo; leaving yourself is the one case where a mistaken click is
    // still trivially reversible by whoever owns the client re-adding you.
    if (!leaving && !window.confirm(`Remove ${label} from this client?`)) return;
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
      return leaving ? "You left this client." : `Removed ${label} from this client.`;
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
      if (options.auto) {
        const { data: existing } = await supabase()
          .from("client_profiles")
          .select("client_id")
          .eq("client_id", clientId)
          .maybeSingle();
        if (existing) return "Skipped the automatic read — a profile was already saved.";
      }

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
      await load();
      // The chain falls through to a small local model when the hosted ones
      // are unreachable. Naming the model is not the same as saying what it
      // means — "ollama/phi4-mini" tells a consultant nothing about how hard
      // to check what it just wrote into their client's profile.
      return provenance.model.startsWith("ollama")
        ? `Read from ${provenance.source}, but the usual models were unreachable so a small local one did it. Check every field before relying on this.`
        : `Read from ${provenance.source} via ${provenance.model}. Check it before relying on it.`;
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
      const budget = Number(text("annualBudget").replace(/[,\s$]/g, ""));
      const leadTime = Number(text("leadTimeWeeks"));
      const partnerLeadTime = Number(text("partnerLeadTimeWeeks"));
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
            // Left unset rather than clamped: the column's own 0-52 check
            // constraint is the actual bound, and clamping a typo like "520"
            // to 52 here would silently save a number the consultant never
            // typed rather than telling them the save failed.
            lead_time_weeks:
              Number.isFinite(leadTime) && leadTime > 0 && leadTime <= 52 ? leadTime : null,
            partner_lead_time_weeks:
              Number.isFinite(partnerLeadTime) && partnerLeadTime > 0 && partnerLeadTime <= 52
                ? partnerLeadTime
                : null,
            funded_partner_pathway: form.get("fundedPartnerPathway") === "on",
            requires_go_decision: form.get("requiresGoDecision") === "on",
            capability_domains: list("capabilityDomains"),
            // A human just confirmed this, which is exactly what the field means.
            reviewed_at: new Date().toISOString(),
          },
          { onConflict: "client_id" },
        );
      if (saveError) throw saveError;
      await load();
      return "Profile saved.";
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
      return `Removed "${answer.label}". Future drafts will not use it.`;
    });
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
            disabled={busy !== null}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy === "extract"
              ? "Reading…"
              : profile !== null
                ? "Read the page again"
                : "Read the page"}
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
            name="leadTimeWeeks"
            label="Lead time"
            hint="Weeks this client usually needs to write a credible application"
            defaultValue={fields.leadTimeWeeks ? String(fields.leadTimeWeeks) : ""}
          />
          <EditField
            name="partnerLeadTimeWeeks"
            label="Lead time as partner"
            hint="Weeks needed when a partner must apply as lead (default 8)"
            defaultValue={
              profile?.partner_lead_time_weeks ? String(profile.partner_lead_time_weeks) : ""
            }
          />
          <EditField
            name="capabilityDomains"
            label="Capability domains"
            hint="Comma separated — supply chain, micro-credentials, smart cities"
            defaultValue={(profile?.capability_domains ?? []).join(", ")}
          />
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
                Can join as a <strong>funded partner</strong> — an eligible lead (usually a
                municipality) applies and writes this client into the budget as a paid partner.
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
                Requires a <strong>leadership go / no-go</strong> on the Opportunity Brief before
                any drafting.
              </span>
            </label>
          </div>
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
              disabled={busy !== null}
              className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {busy === "save" ? "Saving…" : "Save profile"}
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

      <section className="mt-10" data-testid="team">
        <h2 className="text-sm font-semibold">Who has access</h2>
        <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-soft)]">
          Everyone here sees the same matches, drafts and submissions for this client — a shared
          desk, not separate copies.
        </p>

        <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
          <li className="flex items-center justify-between bg-[var(--color-surface)] px-4 py-3 text-sm">
            <span>{client?.consultant_id === myId ? "You" : "The owner"}</span>
            <span className="text-xs text-[var(--color-ink-soft)]">Owner</span>
          </li>
          {(team ?? []).map((member) => (
            <li
              key={member.user_id}
              data-testid="team-member"
              className="flex items-center justify-between bg-[var(--color-surface)] px-4 py-3 text-sm"
            >
              <span>
                {member.user_id === myId
                  ? "You"
                  : member.consultants?.display_name || member.consultants?.email || "Unknown"}
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
                  {member.user_id === myId ? "Leave" : "Remove"}
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
              Add to this client
            </button>
          </form>
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
