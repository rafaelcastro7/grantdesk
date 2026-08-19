import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ACCESS_TOKEN_MESSAGE, callerClient } from "./caller";
import { ProfileTooThinError, runMatch } from "./match";

export const findMatches = createServerFn({ method: "POST" })
  .validator(
    z.object({
      clientId: z.string().uuid(),
      accessToken: z.string().min(10, ACCESS_TOKEN_MESSAGE),
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
