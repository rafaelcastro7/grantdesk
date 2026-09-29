import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser client. Every read and write from the UI goes through this, which
 * means every one of them is subject to row-level security — a consultant
 * cannot reach another's client even if a query forgets its filter.
 *
 * Secrets never live here: the anon key is public by design, and anything
 * needing a real key (LLM providers, importers) runs in a server function.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
// Lovable Cloud provides the public key as VITE_SUPABASE_PUBLISHABLE_KEY.
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ??
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) as string | undefined;

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (client) return client;
  if (!url || !anonKey) {
    throw new Error(
      "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY) are required.",
    );
  }
  client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return client;
}
