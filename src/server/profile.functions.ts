import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { extractProfileFromUrl } from "./extract-profile";

/**
 * Profile extraction runs on the server because it needs provider API keys.
 * Everything else about a client — creating it, saving the profile — goes
 * straight from the browser to Postgres, where RLS enforces ownership. Routing
 * those writes through a server function would only move the security boundary
 * somewhere easier to get wrong.
 */
export const extractProfile = createServerFn({ method: "POST" })
  .validator(
    z.object({
      url: z
        .string()
        .url("That does not look like a web address.")
        .refine((value) => /^https?:\/\//i.test(value), "Only http(s) addresses can be read."),
    }),
  )
  .handler(async ({ data }) => {
    try {
      const { profile, provenance } = await extractProfileFromUrl(data.url);
      return { ok: true as const, profile, provenance };
    } catch (error) {
      // Reaching a stranger's website fails for ordinary reasons — it moved, it
      // renders through script, it blocks robots. Say which, so the consultant
      // can paste a different page instead of guessing.
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
