import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_ATTEMPTS,
  RESEND_ENDPOINT,
  emailConfig,
  planRow,
  runOutbox,
  sendOutbox,
  type OutboxRow,
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
});
