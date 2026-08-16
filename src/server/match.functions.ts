import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { serverEnv } from "@/lib/env.server";
import { ProfileTooThinError, runMatch } from "./match";

/**
 * Matching runs on the server only because the embedder does — it is a local
 * model this browser cannot reach. Everything else about the request stays
 * exactly where it was: the run acts as the signed-in consultant, using their
 * own access token, so row-level security still decides what may be read and
 * written.
 *
 * The alternative — a service-role client plus an ownership check written here
 * — would move that decision out of the database and into a line of TypeScript
 * that a later refactor can drop without any test noticing. The token is passed
 * explicitly because a server function is called by the framework's own RPC
 * transport, which carries no Supabase session of its own.
 */
function callerClient(accessToken: string) {
  const env = serverEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export const findMatches = createServerFn({ method: "POST" })
  .validator(
    z.object({
      clientId: z.string().uuid(),
      accessToken: z.string().min(10, "Your session expired. Sign in again."),
    }),
  )
  .handler(async ({ data }) => {
    try {
      const result = await runMatch(callerClient(data.accessToken), data.clientId);
      return { ok: true as const, result };
    } catch (error) {
      if (error instanceof ProfileTooThinError) {
        return {
          ok: false as const,
          error:
            "This profile has nothing to search on yet. Add the sectors this client works in, then run matching again.",
        };
      }
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
