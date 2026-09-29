import type { SupabaseClient } from "@supabase/supabase-js";
import { formatFrom } from "@/lib/email-settings";

/**
 * Delivers email_outbox, per tenant, through Resend's HTTP API or SMTP.
 *
 * Each tenant may save its own mailbox on /settings/email (a Gmail account
 * with an App Password today, its own domain later); those settings are
 * decrypted server-side by get_tenant_email_transports(). A tenant with no
 * enabled settings falls back to the environment's RESEND_API_KEY /
 * EMAIL_FROM. Resend stays HTTP because the hosted deployment has no
 * long-lived process: one fetch with an API key works from anywhere.
 */

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const MAX_ATTEMPTS = 3;
export const STALE_AFTER_MS = 7 * 86_400_000;
/** Wait after the Nth failed attempt before trying again. */
export const BACKOFF_MS = [0, 15 * 60_000, 2 * 60 * 60_000] as const;
export const TEST_DOMAIN = "@grantdesk.test";

export type OutboxRow = {
  id: string;
  tenant_id?: string | null;
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

// ── Transports ──────────────────────────────────────────────────────────────

export type ResendTransport = { kind: "resend"; apiKey: string; from: string; replyTo?: string };
export type SmtpTransport = {
  kind: "smtp";
  host: string;
  port: number;
  secure: "tls" | "starttls";
  user: string;
  pass: string;
  from: string;
  replyTo?: string;
};
export type Transport = ResendTransport | SmtpTransport;

export type Message = {
  to: string;
  subject: string;
  html: string;
  /** Stable per outbox row, so a retry cannot deliver the same reminder twice. */
  idempotencyKey: string;
};

/** The slice of a nodemailer transporter this module uses; mockable. */
export type SmtpClient = {
  sendMail: (options: Record<string, unknown>) => Promise<unknown>;
  close?: () => void;
};
export type SmtpFactory = (transport: SmtpTransport) => SmtpClient | Promise<SmtpClient>;

export const defaultSmtpFactory: SmtpFactory = async (t) => {
  const { createTransport } = await import("nodemailer");
  return createTransport({
    host: t.host,
    port: t.port,
    // 465 speaks TLS from the first byte; 587 upgrades with STARTTLS and must
    // refuse to continue in plaintext if the upgrade is not offered.
    secure: t.secure === "tls",
    requireTLS: t.secure === "starttls",
    auth: { user: t.user, pass: t.pass },
    // Gmail and Microsoft 365 throttle parallel connections per mailbox.
    pool: true,
    maxConnections: 3,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  }) as unknown as SmtpClient;
};

export function envTransport(config: { apiKey: string; from: string }): ResendTransport {
  return { kind: "resend", apiKey: config.apiKey, from: config.from };
}

export type TenantTransportRow = {
  tenant_id: string;
  provider: string;
  from_name: string | null;
  from_address: string;
  reply_to: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: string | null;
  smtp_user: string | null;
  secret: string | null;
  enabled: boolean;
};

/** A saved row as a usable transport, or why it is not one. */
export function toTransport(
  row: TenantTransportRow,
): { ok: true; transport: Transport } | { ok: false; reason: string } {
  if (!row.secret) return { ok: false, reason: "no password or API key saved" };
  const from = formatFrom(row.from_name, row.from_address);
  const replyTo = row.reply_to ?? undefined;
  if (row.provider === "resend") {
    return { ok: true, transport: { kind: "resend", apiKey: row.secret, from, replyTo } };
  }
  if (row.provider !== "smtp") return { ok: false, reason: `unknown provider ${row.provider}` };
  if (!row.smtp_host || !row.smtp_port || !row.smtp_user) {
    return { ok: false, reason: "SMTP host, port or username missing" };
  }
  return {
    ok: true,
    transport: {
      kind: "smtp",
      host: row.smtp_host,
      port: row.smtp_port,
      secure: row.smtp_secure === "starttls" ? "starttls" : "tls",
      user: row.smtp_user,
      pass: row.secret,
      from,
      replyTo,
    },
  };
}

/** Every tenant's saved settings, decrypted. Needs the service role. */
export async function loadTenantSettings(
  supabase: SupabaseClient,
  encryptionKey: string,
): Promise<TenantTransportRow[]> {
  const { data, error } = await supabase.rpc("get_tenant_email_transports", {
    p_encryption_key: encryptionKey,
  });
  if (error) throw new Error(`could not read tenant email settings: ${error.message}`);
  return (data ?? []) as TenantTransportRow[];
}

/** Enabled, complete tenant settings as transports, keyed by tenant. */
export async function loadTenantTransports(
  supabase: SupabaseClient,
  encryptionKey: string,
): Promise<Map<string, Transport>> {
  const map = new Map<string, Transport>();
  for (const row of await loadTenantSettings(supabase, encryptionKey)) {
    if (!row.enabled) continue;
    const built = toTransport(row);
    if (built.ok) map.set(row.tenant_id, built.transport);
  }
  return map;
}

// ── Outbox ──────────────────────────────────────────────────────────────────

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
  /** Rows left pending because their tenant has no sender and no fallback exists. */
  unconfigured: number;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type DeliverDeps = {
  fetchImpl: FetchLike;
  smtpClient: (transport: SmtpTransport) => Promise<SmtpClient>;
};

export async function sendOutbox({
  supabase,
  config,
  tenantTransports = new Map(),
  fetchImpl = fetch,
  smtpFactory = defaultSmtpFactory,
  now = new Date(),
  batchSize = 20,
  maxRows = 500,
}: {
  supabase: SupabaseClient;
  /** The environment fallback, for tenants that have saved no settings. */
  config?: { apiKey: string; from: string } | null;
  tenantTransports?: Map<string, Transport>;
  fetchImpl?: FetchLike;
  smtpFactory?: SmtpFactory;
  now?: Date;
  batchSize?: number;
  maxRows?: number;
}): Promise<SendResult> {
  const { data, error } = await supabase
    .from("email_outbox")
    .select(
      "id, tenant_id, recipient_email, subject, body_html, status, attempts, last_attempt_at, created_at",
    )
    .in("status", ["pending", "failed"])
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(maxRows);
  if (error) throw new Error(`could not read the email outbox: ${error.message}`);

  const result: SendResult = {
    sent: 0,
    failed: 0,
    stale: 0,
    testRecipients: 0,
    waiting: 0,
    unconfigured: 0,
  };
  const fallback = config ? envTransport(config) : null;
  const transportFor = (row: OutboxRow): Transport | null =>
    (row.tenant_id ? tenantTransports.get(row.tenant_id) : undefined) ?? fallback;
  const due: Array<{ row: OutboxRow; transport: Transport }> = [];

  for (const row of (data ?? []) as OutboxRow[]) {
    const plan = planRow(row, now);
    if (plan === "send") {
      // Left pending with no attempt counted: configuring email later sends it.
      const transport = transportFor(row);
      if (transport) due.push({ row, transport });
      else result.unconfigured++;
    } else if (plan === "backoff") result.waiting++;
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

  // One SMTP connection pool per tenant for the whole run.
  const smtpClients = new Map<SmtpTransport, Promise<SmtpClient>>();
  const deps: DeliverDeps = {
    fetchImpl,
    smtpClient: (t) => {
      let client = smtpClients.get(t);
      if (!client) {
        client = Promise.resolve(smtpFactory(t));
        smtpClients.set(t, client);
      }
      return client;
    },
  };

  try {
    for (let i = 0; i < due.length; i += batchSize) {
      const batch = due.slice(i, i + batchSize);
      const outcomes = await Promise.all(
        batch.map(({ row, transport }) =>
          deliver(
            transport,
            {
              to: row.recipient_email,
              subject: row.subject,
              html: row.body_html,
              idempotencyKey: `outbox-${row.id}`,
            },
            deps,
          ),
        ),
      );
      for (const [index, outcome] of outcomes.entries()) {
        const row = batch[index]!.row;
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
  } finally {
    for (const client of smtpClients.values()) {
      await client.then((c) => c.close?.()).catch(() => {});
    }
  }
  return result;
}

/** Send one message through whichever provider the transport names. */
export async function deliver(
  transport: Transport,
  message: Message,
  deps: Partial<DeliverDeps> & { smtpFactory?: SmtpFactory } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (transport.kind === "smtp") {
    // Without a shared pool (the test-email action), open and close our own.
    const ownClient = !deps.smtpClient;
    let client: SmtpClient | null = null;
    try {
      client = deps.smtpClient
        ? await deps.smtpClient(transport)
        : await (deps.smtpFactory ?? defaultSmtpFactory)(transport);
      await client.sendMail({
        from: transport.from,
        to: message.to,
        replyTo: transport.replyTo,
        subject: message.subject,
        html: message.html,
        // SMTP has no idempotency key. A stable Message-ID is the closest
        // thing: receiving servers (Gmail included) collapse duplicates of it.
        messageId: `<${message.idempotencyKey}@grantdesk.local>`,
      });
      return { ok: true };
    } catch (caught) {
      return { ok: false, error: `smtp: ${smtpError(caught)}` };
    } finally {
      if (ownClient) client?.close?.();
    }
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${transport.apiKey}`,
        "Content-Type": "application/json",
        // Resend drops a repeat of the same key, so a retry after a lost
        // response cannot deliver the same reminder twice.
        "Idempotency-Key": message.idempotencyKey,
      },
      body: JSON.stringify({
        from: transport.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        ...(transport.replyTo ? { reply_to: transport.replyTo } : {}),
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

/** A provider error in words a consultant can act on; never echoes a credential. */
export function smtpError(caught: unknown): string {
  const text = caught instanceof Error ? caught.message : String(caught);
  const code = (caught as { responseCode?: number } | null)?.responseCode;
  if (code === 535 || /\b535\b|Invalid login|Username and Password not accepted/i.test(text)) {
    return "the server rejected the username or password (for Gmail, use an App Password, not the account password)";
  }
  return text.slice(0, 300);
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
  const key = env.EMAIL_SETTINGS_KEY?.trim();
  const tenantTransports = key
    ? await loadTenantTransports(supabase, key)
    : new Map<string, Transport>();
  if (!config.ok && tenantTransports.size === 0) {
    console.log(
      key
        ? `${config.reason}, and no tenant has enabled email settings`
        : `${config.reason} (and EMAIL_SETTINGS_KEY is not set, so tenant settings are not read)`,
    );
    return null;
  }
  const result = await sendOutbox({
    supabase,
    config: config.ok ? config : null,
    tenantTransports,
  });
  console.log(
    `email: ${result.sent} sent, ${result.failed} failed, ${result.stale} stale, ` +
      `${result.testRecipients} test recipient(s) skipped, ${result.waiting} waiting to retry, ` +
      `${result.unconfigured} with no configured sender`,
  );
  return result;
}
