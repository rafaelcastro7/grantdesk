import { supabase } from "./supabase";

/**
 * The caller's access token, for the few actions that must run on the server.
 *
 * Server functions here act as the consultant rather than escalating to the
 * service role (see src/server/caller.ts), so every one of them needs this.
 * Kept in one place because it was copied into two routes and would have been
 * copied into every route that ever calls one.
 */
export async function accessToken(): Promise<string> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired. Sign in again.");
  return token;
}
