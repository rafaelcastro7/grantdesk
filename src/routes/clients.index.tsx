import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { errorMessage } from "@/lib/error-message";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/clients/")({ component: ClientsPage });

type ClientRow = { id: string; name: string; website: string | null; country: string };

/**
 * The client switcher is the top-level surface, not a settings page: a
 * consultant's most frequent action of the day is changing which organization
 * they are working for.
 */
function ClientsPage() {
  const navigate = useNavigate();
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        .select("id, name, website, country")
        .is("archived_at", null)
        .order("name");
      if (loadError) setError(loadError.message);
      setClients((data as ClientRow[]) ?? []);
    })();
  }, [navigate]);

  async function addClient(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data: userData } = await supabase().auth.getUser();
      const consultantId = userData.user?.id;
      if (!consultantId) throw new Error("Your session expired. Sign in again.");

      const { data, error: insertError } = await supabase()
        .from("clients")
        .insert({ consultant_id: consultantId, name: name.trim(), website: website.trim() || null })
        .select("id")
        .single();
      if (insertError) throw insertError;

      await navigate({ to: "/clients/$clientId", params: { clientId: data.id as string } });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
      <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
        Every organization you represent. Matching quality follows profile quality, so a thin
        profile is worth two minutes before it is worth a search.
      </p>

      <form
        onSubmit={addClient}
        className="mt-8 flex flex-wrap items-end gap-3 rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-4"
      >
        <label className="flex min-w-48 flex-1 flex-col gap-1.5 text-sm">
          Organization name
          <input
            name="clientName"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] px-3 py-2"
          />
        </label>
        <label className="flex min-w-56 flex-1 flex-col gap-1.5 text-sm">
          Website{" "}
          <span className="text-[var(--color-ink-soft)]">(we read it to fill the profile)</span>
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
          disabled={busy}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add client"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-4 text-sm text-[var(--color-ineligible)]">
          {error}
        </p>
      )}

      <section className="mt-8">
        {clients === null ? (
          <p className="text-sm text-[var(--color-ink-soft)]">Loading…</p>
        ) : clients.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-soft)]">
            No clients yet. Add the first one above.
          </p>
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
                    {client.country}
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
