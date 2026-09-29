/**
 * Which OAuth providers the sign-in screen offers, and how to read what the
 * provider sent back.
 *
 * A provider button is shown only when its flag is set, because a button for a
 * provider the Supabase project has not configured fails with a raw
 * "Unsupported provider" page on the provider's side — the worst place to fail.
 */

export type SsoProvider = "google" | "azure";

export const SSO_LABELS: Record<SsoProvider, string> = {
  google: "Sign in with Google",
  azure: "Sign in with Microsoft",
};

export function enabledSsoProviders(env: Record<string, unknown>): SsoProvider[] {
  const providers: SsoProvider[] = [];
  if (String(env.VITE_AUTH_GOOGLE ?? "") === "1") providers.push("google");
  if (String(env.VITE_AUTH_AZURE ?? "") === "1") providers.push("azure");
  return providers;
}

export type SsoCallback =
  { kind: "none" } | { kind: "code"; code: string } | { kind: "error"; message: string };

/**
 * PKCE returns `?code=`; a refusal (consent denied, domain not allowed by the
 * provider) comes back as `error`/`error_description`, in the query or the
 * hash depending on the provider — both are checked so it is never swallowed.
 */
export function readSsoCallback(search: string, hash: string): SsoCallback {
  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  for (const params of [query, fragment]) {
    const error = params.get("error_description") ?? params.get("error");
    if (error) return { kind: "error", message: `Single sign-on failed: ${error}` };
  }
  const code = query.get("code");
  return code ? { kind: "code", code } : { kind: "none" };
}
