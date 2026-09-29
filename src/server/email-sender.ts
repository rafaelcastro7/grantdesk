import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Delivers email_outbox through Resend's HTTP API.
 *
 * HTTP rather than SMTP because the hosted deployment has no long-lived
 * process or open ports of its own: one fetch with an API key works the same
 * from a script on this machine and from a server on Lovable.
 */

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const MAX_ATTEMPTS = 3;
export const STALE_AFTER_MS = 7 * 86_400_000;
/** Wait after the Nth failed attempt before trying again. */
export const BACKOFF_MS = [0, 15 * 60_000, 2 * 60 * 60_000] as const;
export const TEST_DOMAIN = "@grantdesk.test";

export type OutboxRow = {
  id: string;
  recipient_email: string;
  subject: string;
  body_html: string;
  status: "pending" | "failed";
  attempts: number;
  last_attempt_at: string | null;
  created_at: string;
};

export type EmailConfig =
  { ok: true; apiKey: string; from: string } | { ok: false; reason: string };

export function emailConfig(env: Record<string, string | undefined>): EmailConfig {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!apiKey) return { ok: false, reason: "email not configured: RESEND_API_KEY is not set" };
  if (!from) return { ok: false, reason: "email not configured: EMAIL_FROM is not set" };
  return { ok: true, apiKey, from };
}

export type RowPlan = "send" | "stale" | "test_recipient" | "backoff" | "exhausted";

export function planRow(row: OutboxRow, now: Date): RowPlan {
  if (row.attempts >= MAX_ATTEMPTS) return "exhausted";
  // A reminder for a deadline that has since passed is worse than none.
  if (now.getTime() - Date.parse(row.created_at) > STALE_AFTER_MS) return "stale";
  if (row.recipient_email.trim().toLowerCase().endsWith(TEST_DOMAIN)) return "test_recipient";
  if (row.status === "failed" && row.last_attempt_at) {
    const wait = BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)] ?? 0;
    if (now.getTime() - Date.parse(row.last_attempt_at) < wait) return "backoff";
  }
  return "send";
}

export type SendResult = {
  sent: number;
  failed: number;
  stale: number;
  testRecipients: number;
  waiting: number;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function sendOutbox({
  supabase,
  config,
  fetchImpl = fetch,
  now = new Date(),
  batchSize = 20,
  maxRows = 500,
}: {
  supabase: SupabaseClient;
  config: { apiKey: string; from: string };
  fetchImpl?: FetchLike;
  now?: Date;
  batchSize?: number;
  maxRows?: number;
}): Promise<SendResult> {
  const { data, error } = await supabase
    .from("email_outbox")
    .select(
      "id, recipient_email, subject, body_html, status, attempts, last_attempt_at, created_at",
    )
    .in("status", ["pending", "failed"])
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(maxRows);
  if (error) throw new Error(`could not read the email outbox: ${error.message}`);

  const result: SendResult = { sent: 0, failed: 0, stale: 0, testRecipients: 0, waiting: 0 };
  const due: OutboxRow[] = [];

  for (const row of (data ?? []) as OutboxRow[]) {
    const plan = planRow(row, now);
    if (plan === "send") due.push(row);
    else if (plan === "backoff") result.waiting++;
    else if (plan === "stale" || plan === "test_recipient") {
      // Final: attempts is set to the cap so the row is never picked up again.
      await update(supabase, row.id, {
        status: "failed",
        error: plan === "stale" ? "stale" : "test recipient, not sent",
        attempts: MAX_ATTEMPTS,
        last_attempt_at: now.toISOString(),
      });
      if (plan === "stale") result.stale++;
      else result.testRecipients++;
    }
  }

  for (let i = 0; i < due.length; i += batchSize) {
    const batch = due.slice(i, i + batchSize);
    const outcomes = await Promise.all(batch.map((row) => deliver(row, config, fetchImpl)));
    for (const [index, outcome] of outcomes.entries()) {
      const row = batch[index]!;
      if (outcome.ok) {
        await update(supabase, row.id, {
          status: "sent",
          sent_at: now.toISOString(),
          error: null,
          attempts: row.attempts + 1,
          last_attempt_at: now.toISOString(),
        });
        result.sent++;
      } else {
        await update(supabase, row.id, {
          status: "failed",
          error: outcome.error,
          attempts: row.attempts + 1,
          last_attempt_at: now.toISOString(),
        });
        result.failed++;
      }
    }
  }
  return result;
}

async function deliver(
  row: OutboxRow,
  config: { apiKey: string; from: string },
  fetchImpl: FetchLike,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        // Resend drops a repeat of the same key, so a retry after a lost
        // response cannot deliver the same reminder twice.
        "Idempotency-Key": `outbox-${row.id}`,
      },
      body: JSON.stringify({
        from: config.from,
        to: [row.recipient_email],
        subject: row.subject,
        html: row.body_html,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return { ok: true };
    const text = await response.text().catch(() => "");
    return { ok: false, error: `resend ${response.status}: ${text.slice(0, 300)}` };
  } catch (caught) {
    return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
  }
}

async function update(supabase: SupabaseClient, id: string, fields: Record<string, unknown>) {
  const { error } = await supabase.from("email_outbox").update(fields).eq("id", id);
  if (error) throw new Error(`could not record delivery for outbox row ${id}: ${error.message}`);
}

/** The whole job for a script: configured or say why not, then send. */
export async function runOutbox(
  supabase: SupabaseClient,
  env: Record<string, string | undefined> = process.env,
): Promise<SendResult | null> {
  const config = emailConfig(env);
  if (!config.ok) {
    console.log(config.reason);
    return null;
  }
  const result = await sendOutbox({ supabase, config });
  console.log(
    `email: ${result.sent} sent, ${result.failed} failed, ${result.stale} stale, ` +
      `${result.testRecipients} test recipient(s) skipped, ${result.waiting} waiting to retry`,
  );
  return result;
}
