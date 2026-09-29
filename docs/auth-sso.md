# Single sign-on (Google, Microsoft)

The sign-in screen offers "Sign in with Google" and "Sign in with Microsoft"
through Supabase Auth's OAuth providers (`google`, `azure`). Each button is
hidden unless its flag is set, so a provider that is not configured never
appears as a broken button:

| Flag                 | Shows                  |
| -------------------- | ---------------------- |
| `VITE_AUTH_GOOGLE=1` | Sign in with Google    |
| `VITE_AUTH_AZURE=1`  | Sign in with Microsoft |

## How the flow works

1. The button calls `supabase.auth.signInWithOAuth({ provider, options: { redirectTo: <origin>/auth } })`.
2. The provider returns to Supabase (`/auth/v1/callback`), which redirects to
   `<origin>/auth?code=…`. The client uses PKCE (`src/lib/supabase.ts`).
3. `/auth` exchanges the code with `exchangeCodeForSession`, then goes to
   `/clients`. A provider refusal (`?error_description=…`) is shown on the form.

## Which tenant a new SSO user joins

The same rule as email sign-up (migration `0043_tenant_email_domains.sql`): a
new account joins a tenant only when `tenants.allowed_email_domains` lists its
email domain; otherwise it gets a personal tenant of its own. To let a firm's
colleagues land in its workspace, add the firm's domain:

```sql
update tenants set allowed_email_domains = array_append(allowed_email_domains, 'example.org')
 where slug = 'your-tenant';
```

Never add a public mailbox domain (gmail.com, outlook.com…): that admits every
account at the provider.

## Provider credentials

- **Google** — Google Cloud Console → APIs & Services → Credentials → OAuth
  client ID (Web). Authorised redirect URI: the Supabase callback URL below.
- **Microsoft** — Microsoft Entra ID → App registrations → New registration.
  Redirect URI (Web): the Supabase callback URL. Create a client secret under
  Certificates & secrets. Use tenant URL `https://login.microsoftonline.com/common`
  for any work/personal account, or your directory's tenant id to restrict it.

## Local stack (docker compose)

1. In `supabase/docker-compose.yml`, uncomment the `GOTRUE_EXTERNAL_GOOGLE_*`
   and/or `GOTRUE_EXTERNAL_AZURE_*` lines under the `auth` service and fill in
   the client id and secret. Callback URL: `http://localhost:15535/auth/v1/callback`.
2. Set `GOTRUE_URI_ALLOW_LIST: "http://localhost:5180/auth"` so Supabase will
   redirect back to the app.
3. Set `VITE_AUTH_GOOGLE=1` / `VITE_AUTH_AZURE=1` in `.env`.
4. `bun run db:down && bun run db:up`, then restart the dev server (Vite reads
   `VITE_*` at start-up).

## Hosted Supabase / Lovable

1. Supabase dashboard → Authentication → Providers → enable Google and/or
   Azure, paste the client id and secret. The callback URL shown there
   (`https://<project-ref>.supabase.co/auth/v1/callback`) is the one to register
   with Google / Microsoft.
2. Authentication → URL Configuration: set Site URL to the published app, and
   add `https://<your-app-domain>/auth` (and the Lovable preview domain, if you
   sign in from it) to Redirect URLs.
3. Set `VITE_AUTH_GOOGLE=1` / `VITE_AUTH_AZURE=1` in the project's environment
   and redeploy — they are build-time variables.
4. Apply migration `0043` to the hosted database before opening sign-ups, or
   every new account still joins IIAL.
