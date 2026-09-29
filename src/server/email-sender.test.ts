import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_ATTEMPTS,
  RESEND_ENDPOINT,
  deliver,
  emailConfig,
  planRow,
  runOutbox,
  sendOutbox,
  smtpError,
  toTransport,
  type OutboxRow,
  type SmtpTransport,
  type TenantTransportRow,
  type Transport,
} from "./email-sender";

const NOW = new Date("2026-09-29T12:00:00Z");

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: overrides.id ?? "r1",
    recipient_email: "ana@example.org",
    subject: "Due soon",
    body_html: "<p>hi</p>",
    status: "pending",
    attempts: 0,
    last_attempt_at: null,
    created_at: "2026-09-29T10:00:00Z",
    ...overrides,
  };
}

function fakeSupabase(rows: OutboxRow[]) {
  const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const query = {
    select: () => query,
    in: () => query,
    lt: () => query,
    order: () => query,
    limit: async () => ({ data: rows, error: null }),
    update: (fields: Record<string, unknown>) => ({
      eq: async (_col: string, id: string) => {
        updates.push({ id, fields });
        return { error: null };
      },
    }),
  };
  const client = { from: () => query } as unknown as SupabaseClient;
  return { client, updates };
}

const config = { apiKey: "re_test", from: "GrantDesk <desk@example.org>" };

describe("emailConfig", () => {
  it("names the missing variable", () => {
    expect(emailConfig({})).toEqual({
      ok: false,
      reason: "email not configured: RESEND_API_KEY is not set",
    });
    expect(emailConfig({ RESEND_API_KEY: "k" })).toMatchObject({ ok: false });
    expect(emailConfig({ RESEND_API_KEY: "k", EMAIL_FROM: "a@b.c" })).toEqual({
      ok: true,
      apiKey: "k",
      from: "a@b.c",
    });
  });
});

describe("planRow", () => {
  it("sends fresh pending rows", () => {
    expect(planRow(row(), NOW)).toBe("send");
  });
  it("never sends rows older than 7 days", () => {
    expect(planRow(row({ created_at: "2026-09-21T11:00:00Z" }), NOW)).toBe("stale");
  });
  it("never sends to the test domain", () => {
    expect(planRow(row({ recipient_email: "Qa@GrantDesk.test" }), NOW)).toBe("test_recipient");
  });
  it("backs off after a failure, longer each time", () => {
    const failedOnce = row({
      status: "failed",
      attempts: 1,
      last_attempt_at: "2026-09-29T11:50:00Z",
    });
    expect(planRow(failedOnce, NOW)).toBe("backoff");
    expect(planRow({ ...failedOnce, last_attempt_at: "2026-09-29T11:40:00Z" }, NOW)).toBe("send");
    const failedTwice = row({
      status: "failed",
      attempts: 2,
      last_attempt_at: "2026-09-29T11:00:00Z",
    });
    expect(planRow(failedTwice, NOW)).toBe("backoff");
  });
  it("stops after the attempt cap", () => {
    expect(planRow(row({ status: "failed", attempts: MAX_ATTEMPTS }), NOW)).toBe("exhausted");
  });
});

describe("sendOutbox", () => {
  it("posts to Resend in batches and marks each row sent", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ id: `r${i}` }));
    const { client, updates } = fakeSupabase(rows);
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      expect(url).toBe(RESEND_ENDPOINT);
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
      const body = JSON.parse(init.body as string);
      expect(body).toMatchObject({
        from: config.from,
        to: ["ana@example.org"],
        subject: "Due soon",
      });
      return new Response("{}", { status: 200 });
    });

    const result = await sendOutbox({
      supabase: client,
      config,
      fetchImpl,
      now: NOW,
      batchSize: 2,
    });

    expect(result.sent).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(updates.every((u) => u.fields.status === "sent" && u.fields.attempts === 1)).toBe(true);
  });

  it("records the provider's error and counts the attempt", async () => {
    const { client, updates } = fakeSupabase([
      row({ status: "failed", attempts: 1, last_attempt_at: "2026-09-29T09:00:00Z" }),
    ]);
    const fetchImpl = vi.fn(async () => new Response("domain not verified", { status: 403 }));

    const result = await sendOutbox({ supabase: client, config, fetchImpl, now: NOW });

    expect(result.failed).toBe(1);
    expect(updates[0]!.fields).toMatchObject({
      status: "failed",
      attempts: 2,
      error: "resend 403: domain not verified",
    });
  });

  it("marks stale and test-domain rows failed without sending them", async () => {
    const { client, updates } = fakeSupabase([
      row({ id: "old", created_at: "2026-09-01T00:00:00Z" }),
      row({ id: "qa", recipient_email: "qa@grantdesk.test" }),
    ]);
    const fetchImpl = vi.fn();

    const result = await sendOutbox({ supabase: client, config, fetchImpl, now: NOW });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stale: 1, testRecipients: 1, sent: 0 });
    expect(updates.find((u) => u.id === "old")!.fields).toMatchObject({
      status: "failed",
      error: "stale",
      attempts: MAX_ATTEMPTS,
    });
    expect(updates.find((u) => u.id === "qa")!.fields).toMatchObject({ attempts: MAX_ATTEMPTS });
  });

  it("leaves rows in backoff untouched", async () => {
    const { client, updates } = fakeSupabase([
      row({ status: "failed", attempts: 1, last_attempt_at: "2026-09-29T11:59:00Z" }),
    ]);
    const result = await sendOutbox({ supabase: client, config, fetchImpl: vi.fn(), now: NOW });
    expect(result.waiting).toBe(1);
    expect(updates).toHaveLength(0);
  });

  it("treats a network error as a failed attempt", async () => {
    const { client, updates } = fakeSupabase([row()]);
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await sendOutbox({ supabase: client, config, fetchImpl, now: NOW });
    expect(updates[0]!.fields).toMatchObject({
      status: "failed",
      error: "ECONNRESET",
      attempts: 1,
    });
  });
});

describe("runOutbox", () => {
  it("does not touch the outbox when email is not configured", async () => {
    const from = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runOutbox({ from } as unknown as SupabaseClient, {});
    expect(result).toBeNull();
    expect(from).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("email not configured"));
    log.mockRestore();
  });

  it("reads tenant settings with the key and sends even without the env fallback", async () => {
    const { client } = fakeSupabase([row({ tenant_id: TENANT_A })]);
    const rpc = vi.fn(async () => ({
      data: [
        {
          tenant_id: TENANT_A,
          provider: "resend",
          from_name: null,
          from_address: "a@iial.ca",
          reply_to: null,
          smtp_host: null,
          smtp_port: null,
          smtp_secure: null,
          smtp_user: null,
          secret: "re_x",
          enabled: true,
        },
      ],
      error: null,
    }));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}", { status: 200 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runOutbox(Object.assign(client, { rpc }) as unknown as SupabaseClient, {
      EMAIL_SETTINGS_KEY: "0123456789abcdef0123",
    });
    expect(rpc).toHaveBeenCalledWith("get_tenant_email_transports", {
      p_encryption_key: "0123456789abcdef0123",
    });
    expect(result).toMatchObject({ sent: 1, unconfigured: 0 });
    fetchMock.mockRestore();
    log.mockRestore();
  });
});

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000000";
const TENANT_B = "bbbbbbbb-0000-0000-0000-000000000000";

const gmail: SmtpTransport = {
  kind: "smtp",
  host: "smtp.gmail.com",
  port: 465,
  secure: "tls",
  user: "me@gmail.com",
  pass: "abcd efgh ijkl mnop",
  from: "IIAL <me@gmail.com>",
  replyTo: "grants@iial.ca",
};

function mockSmtp(fail?: Error) {
  const sent: Array<Record<string, unknown>> = [];
  const close = vi.fn();
  const factory = vi.fn((_t: SmtpTransport) => ({
    sendMail: vi.fn(async (options: Record<string, unknown>) => {
      if (fail) throw fail;
      sent.push(options);
      return { messageId: options.messageId };
    }),
    close,
  }));
  return { sent, close, factory };
}

describe("provider selection", () => {
  it("sends a tenant with SMTP settings over SMTP, others through the env fallback", async () => {
    const { client, updates } = fakeSupabase([
      row({ id: "a1", tenant_id: TENANT_A }),
      row({ id: "a2", tenant_id: TENANT_A }),
      row({ id: "b1", tenant_id: TENANT_B }),
    ]);
    const smtp = mockSmtp();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    const result = await sendOutbox({
      supabase: client,
      config,
      tenantTransports: new Map<string, Transport>([[TENANT_A, gmail]]),
      fetchImpl,
      smtpFactory: smtp.factory,
      now: NOW,
    });

    expect(result.sent).toBe(3);
    // One pooled client for the tenant, reused and closed at the end.
    expect(smtp.factory).toHaveBeenCalledTimes(1);
    expect(smtp.close).toHaveBeenCalledTimes(1);
    expect(smtp.sent).toHaveLength(2);
    expect(smtp.sent[0]).toMatchObject({
      from: "IIAL <me@gmail.com>",
      to: "ana@example.org",
      replyTo: "grants@iial.ca",
      subject: "Due soon",
      messageId: "<outbox-a1@grantdesk.local>",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(updates.map((u) => u.fields.status)).toEqual(["sent", "sent", "sent"]);
  });

  it("uses a tenant's Resend key instead of the env key", async () => {
    const { client } = fakeSupabase([row({ tenant_id: TENANT_A })]);
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_tenant");
      expect(JSON.parse(init.body as string)).toMatchObject({
        from: "iial@iial.ca",
        reply_to: "grants@iial.ca",
      });
      return new Response("{}", { status: 200 });
    });
    const result = await sendOutbox({
      supabase: client,
      config,
      tenantTransports: new Map<string, Transport>([
        [
          TENANT_A,
          { kind: "resend", apiKey: "re_tenant", from: "iial@iial.ca", replyTo: "grants@iial.ca" },
        ],
      ]),
      fetchImpl,
      now: NOW,
    });
    expect(result.sent).toBe(1);
  });

  it("leaves a row untouched when neither the tenant nor the env has a sender", async () => {
    const { client, updates } = fakeSupabase([row({ tenant_id: TENANT_B })]);
    const fetchImpl = vi.fn();
    const result = await sendOutbox({
      supabase: client,
      config: null,
      tenantTransports: new Map<string, Transport>([[TENANT_A, gmail]]),
      fetchImpl,
      now: NOW,
    });
    expect(result.unconfigured).toBe(1);
    expect(updates).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records an SMTP login failure in plain words, without the password", async () => {
    const { client, updates } = fakeSupabase([row({ tenant_id: TENANT_A })]);
    const failure = Object.assign(
      new Error("Invalid login: 535-5.7.8 Username and Password not accepted"),
      { responseCode: 535 },
    );
    const smtp = mockSmtp(failure);
    const result = await sendOutbox({
      supabase: client,
      tenantTransports: new Map<string, Transport>([[TENANT_A, gmail]]),
      smtpFactory: smtp.factory,
      now: NOW,
    });
    expect(result.failed).toBe(1);
    const error = String(updates[0]!.fields.error);
    expect(error).toMatch(/^smtp: .*App Password/);
    expect(error).not.toContain(gmail.pass);
    expect(updates[0]!.fields.attempts).toBe(1);
  });
});

describe("deliver", () => {
  it("opens and closes its own SMTP client for a one-off send", async () => {
    const smtp = mockSmtp();
    const outcome = await deliver(
      gmail,
      { to: "me@gmail.com", subject: "Test", html: "<p>t</p>", idempotencyKey: "settings-test-1" },
      { smtpFactory: smtp.factory },
    );
    expect(outcome).toEqual({ ok: true });
    expect(smtp.close).toHaveBeenCalledTimes(1);
  });
});

describe("toTransport", () => {
  const base: TenantTransportRow = {
    tenant_id: TENANT_A,
    provider: "smtp",
    from_name: "IIAL Grants",
    from_address: "me@gmail.com",
    reply_to: null,
    smtp_host: "smtp.gmail.com",
    smtp_port: 465,
    smtp_secure: "tls",
    smtp_user: "me@gmail.com",
    secret: "app-password",
    enabled: true,
  };
  it("builds SMTP with a formatted From", () => {
    expect(toTransport(base)).toEqual({
      ok: true,
      transport: expect.objectContaining({
        kind: "smtp",
        host: "smtp.gmail.com",
        secure: "tls",
        from: "IIAL Grants <me@gmail.com>",
      }),
    });
  });
  it("builds STARTTLS for Microsoft 365", () => {
    const built = toTransport({
      ...base,
      smtp_host: "smtp.office365.com",
      smtp_port: 587,
      smtp_secure: "starttls",
    });
    expect(built.ok && built.transport.kind === "smtp" && built.transport.secure).toBe("starttls");
  });
  it("builds Resend from a saved key", () => {
    expect(toTransport({ ...base, provider: "resend", secret: "re_x" })).toMatchObject({
      ok: true,
      transport: { kind: "resend", apiKey: "re_x" },
    });
  });
  it("refuses settings without a secret", () => {
    expect(toTransport({ ...base, secret: null })).toMatchObject({ ok: false });
  });
});

describe("smtpError", () => {
  it("passes other errors through", () => {
    expect(smtpError(new Error("connect ETIMEDOUT"))).toBe("connect ETIMEDOUT");
  });
});
