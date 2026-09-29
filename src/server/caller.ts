import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env.server";

/**
 * A Supabase client that acts as the signed-in consultant.
 *
 * Server functions exist here only for things the browser cannot do — reach a
 * provider API key, call the local embedder, fetch a third-party page. None of
 * them is a reason to escalate privilege, so they all run under the caller's
 * own token and row-level security keeps deciding what may be read and written.
 * A service-role client plus an ownership check in TypeScript would move that
 * decision out of the database and into a line a later refactor can drop
 * without any test noticing.
 *
 * The token is passed explicitly rather than read from a header: a server
 * function is invoked by the framework's own RPC transport, which carries no
 * Supabase session of its own.
 */
export function callerClient(accessToken: string): SupabaseClient {
  const env = serverEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Service-role client, for shared catalog data no consultant owns (grants,
 * extracted requirements). Never for anything a client owns.
 */
export function catalogWriter(): SupabaseClient {
  const env = serverEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The shape every server function here validates its token with. */
export const ACCESS_TOKEN_MESSAGE = "Your session expired. Sign in again.";
