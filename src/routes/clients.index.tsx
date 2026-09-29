import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAction } from "@/lib/use-action";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useDocumentTitle } from "@/lib/use-document-title";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/clients/")({ component: ClientsPage });

type ClientRow = {
  id: string;
  name: string;
  website: string | null;
  client_profiles:
    { jurisdictions: string[] | null } | Array<{ jurisdictions: string[] | null }> | null;
};

/** Where the profile says they operate — not the column default every client gets. */
function operatesIn(row: ClientRow, notFilled: string): string {
  const profile = Array.isArray(row.client_profiles) ? row.client_profiles[0] : row.client_profiles;
  const places = profile?.jurisdictions ?? [];
  return places.length ? places.join(", ") : notFilled;
}

/**
 * The client switcher is the top-level surface, not a settings page: a
 * consultant's most frequent action of the day is changing which organization
 * they are working for.
 */
function ClientsPage() {
  const { t } = useI18n();
  useDocumentTitle(t("clients.title"));
  const navigate = useNavigate();
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const { busy, error, run, setError } = useAction();

  useEffect(() => {
    void (async () => {
      // getUser() rather than getSession(): it validates against the server and
      // waits for a session still being written to storage. getSession() can
      // return null in the instant after sign-up, which bounced a freshly
      // signed-in consultant back to the login screen with no explanation.
      const { data: user } = await supabase().auth.getUser();
      if (!user.user) {
        await navigate({ to: "/auth" });
        return;
      }
      const { data, error: loadError } = await supabase()
        .from("clients")
        .select("id, name, website, client_profiles(jurisdictions)")
        .is("archived_at", null)
        .order("name");
      if (loadError) {
        setError(loadError.message);
        return;
      }
      setClients((data as unknown as ClientRow[]) ?? []);
    })();
  }, [navigate]);

  async function addClient(event: React.FormEvent) {
    event.preventDefault();
    await run("add", async () => {
      const { data: userData } = await supabase().auth.getUser();
      const consultantId = userData.user?.id;
      if (!consultantId) throw new Error(t("clients.sessionExpired"));

      const { data, error: insertError } = await supabase()
        .from("clients")
        .insert({ consultant_id: consultantId, name: name.trim(), website: website.trim() || null })
        .select("id")
        .single();
      if (insertError) throw insertError;

      await navigate({ to: "/clients/$clientId", params: { clientId: data.id as string } });
    });
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">{t("clients.title")}</h1>
      <p className="mt-2 text-sm text-[var(--color-ink-soft)]">{t("clients.intro")}</p>

      <form
        onSubmit={addClient}
        className="mt-8 flex flex-wrap items-end gap-3 rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-4"
      >
        <label className="flex min-w-48 flex-1 flex-col gap-1.5 text-sm">
          {t("clients.orgName")}
          <input
            name="clientName"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 py-2"
          />
        </label>
        <label className="flex min-w-56 flex-1 flex-col gap-1.5 text-sm">
          {t("clients.website")}{" "}
          <span className="text-[var(--color-ink-soft)]">{t("clients.websiteHint")}</span>
          <input
            name="clientWebsite"
            type="url"
            placeholder="https://example.org/about"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
            className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={busy !== null}
          className="rounded-md bg-[var(--color-accent-strong)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? t("clients.adding") : t("clients.add")}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-4 text-sm text-[var(--color-ineligible)]">
          {error}
        </p>
      )}

      <section className="mt-8">
        {clients === null ? (
          <p className="text-sm text-[var(--color-ink-soft)]">
            {error ? "" : t("clients.loading")}
          </p>
        ) : clients.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-soft)]">{t("clients.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
            {clients.map((client) => (
              <li key={client.id} className="bg-[var(--color-surface)]">
                <Link
                  to="/clients/$clientId"
                  params={{ clientId: client.id }}
                  className="flex items-baseline justify-between gap-3 px-4 py-3 hover:bg-[var(--color-accent-soft)]"
                >
                  <span className="font-medium">{client.name}</span>
                  <span className="font-mono text-xs text-[var(--color-ink-soft)]">
                    {operatesIn(client, t("clients.profileNotFilled"))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
