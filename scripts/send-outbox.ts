/**
 * Deliver whatever email_outbox has pending, then exit.
 *
 * Without RESEND_API_KEY it says so and exits 0 without touching a row: an
 * unconfigured install is a choice, and `bun run doctor` reports it.
 *
 * Usage: bun run scripts/send-outbox.ts
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });
config({ path: ".env" });

const { runOutbox } = await import("../src/server/email-sender");

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

try {
  const result = await runOutbox(supabase);
  process.exit(result && result.failed > 0 ? 1 : 0);
} catch (caught) {
  console.error(
    `email delivery FAILED  ${caught instanceof Error ? caught.message : String(caught)}`,
  );
  process.exit(1);
}
