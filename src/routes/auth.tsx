import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAction } from "@/lib/use-action";
import { supabase } from "@/lib/supabase";
import { useEffect, useState } from "react";
import { useDocumentTitle } from "@/lib/use-document-title";
import { getTenantBranding, resolveTenantSlug, type TenantBranding } from "@/lib/tenant";

export const Route = createFileRoute("/auth")({ component: AuthPage });

/**
 * The form is uncontrolled on purpose.
 *
 * With controlled inputs, anything that types into the field before React has
 * hydrated — a fast user, a test, an autofill — updates the DOM but not the
 * component state, and the submit then sends empty strings. That surfaced as
 * the server answering "Anonymous sign-ins are disabled", a message about
 * something else entirely. Reading FormData at submit takes whatever is
 * actually in the fields, so the race cannot happen.
 */
function AuthPage() {
  useDocumentTitle("Sign in");
  const navigate = useNavigate();
  const { busy, error, run, setError } = useAction();
  // Resolved from the address the visitor came in on; nothing is shown until
  // then, so another tenant's sign-in never flashes IIAL's mark.
  const [branding, setBranding] = useState<TenantBranding | null>(null);
  useEffect(() => {
    setBranding(
      getTenantBranding(
        resolveTenantSlug({
          hostname: window.location.hostname,
          searchParams: new URLSearchParams(window.location.search),
        }),
      ),
    );
  }, []);

  async function submit(form: HTMLFormElement, mode: "signin" | "signup") {
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");

    if (!email || !password) {
      setError("Enter an email address and a password.");
      return;
    }

    await run(mode, async () => {
      const auth = supabase().auth;
      const result =
        mode === "signup"
          ? await auth.signUp({ email, password })
          : await auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;

      // Sign-up does not always hand back a session, and navigating without one
      // lands on a page that bounces straight back here with nothing
      // explaining why. Establish it explicitly rather than hoping.
      if (!result.data.session) {
        const followUp = await auth.signInWithPassword({ email, password });
        if (followUp.error) throw followUp.error;
      }

      await navigate({ to: "/clients" });
    });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      {/* The sign-in screen is the one place a visitor may arrive with no
          navigation above it, so the mark carries the identity here itself. */}
      {branding?.logoUrl && (
        <img
          src={branding.logoUrl}
          alt={branding.name}
          width={161}
          height={49}
          className="h-9 w-auto dark:hidden"
        />
      )}
      {branding?.logoInverseUrl && (
        <img
          src={branding.logoInverseUrl}
          alt=""
          aria-hidden="true"
          width={162}
          height={51}
          className="hidden h-9 w-auto dark:block"
        />
      )}
      {branding && !branding.logoUrl && <p className="text-lg font-semibold">{branding.name}</p>}
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">GrantDesk</h1>
      <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
        Sign in to your desk. Each client&rsquo;s material stays isolated at the database level.
      </p>

      <form
        className="mt-8 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(event.currentTarget, "signin");
        }}
      >
        <label className="flex flex-col gap-1.5 text-sm">
          Email
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className="rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          Password
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            className="rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2"
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-[var(--color-ineligible)]">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy !== null}
            className="flex-1 rounded-md bg-[var(--color-accent-strong)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Working…" : "Sign in"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={(event) => {
              const form = event.currentTarget.closest("form");
              if (form) void submit(form, "signup");
            }}
            className="rounded-md border border-[var(--color-rule)] px-4 py-2 text-sm disabled:opacity-50"
          >
            Create account
          </button>
        </div>
      </form>
    </main>
  );
}
