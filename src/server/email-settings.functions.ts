import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ACCESS_TOKEN_MESSAGE, callerClient, catalogWriter } from "./caller";
import { serverEnv } from "@/lib/env.server";
import { emailSettingsInput, type EmailSettingsView } from "@/lib/email-settings";
import { deliver, emailConfig, loadTenantSettings, toTransport } from "./email-sender";

/**
 * /settings/email: read, save and test a tenant's outgoing mailbox.
 *
 * Reads and writes run as the signed-in user, so the database decides who is
 * an owner or admin (RLS on tenant_email_settings, the check inside
 * set_tenant_email_settings). The service role is used for one thing only:
 * decrypting the saved secret to send the test message, after the caller has
 * been shown to be an admin of that tenant.
 */

const auth = z.string().min(10, ACCESS_TOKEN_MESSAGE);
const NOT_ADMIN = "Only a workspace owner or admin can change email settings.";

type Caller = { supabase: SupabaseClient; userId: string; email: string | null };

async function signedIn(accessToken: string): Promise<Caller> {
  const supabase = callerClient(accessToken);
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data.user) throw new Error(ACCESS_TOKEN_MESSAGE);
  return { supabase, userId: data.user.id, email: data.user.email ?? null };
}

/** The tenant the caller administers; the first, if they administer several. */
async function adminTenant(caller: Caller): Promise<{ id: string; name: string }> {
  const { data, error } = await caller.supabase
    .from("tenant_members")
    .select("tenant_id, role, tenants(name)")
    .eq("user_id", caller.userId)
    .in("role", ["owner", "admin"])
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(NOT_ADMIN);
  const row = data as unknown as { tenant_id: string; tenants: { name: string } | null };
  return { id: row.tenant_id, name: row.tenants?.name ?? "Workspace" };
}

export const getEmailSettings = createServerFn({ method: "POST" })
  .validator(z.object({ accessToken: auth }))
  .handler(async ({ data }): Promise<EmailSettingsView> => {
    const caller = await signedIn(data.accessToken);
    const tenant = await adminTenant(caller);
    const { data: row, error } = await caller.supabase
      .from("tenant_email_settings")
      .select(
        "provider, from_name, from_address, reply_to, smtp_host, smtp_port, smtp_secure, " +
          "smtp_user, has_secret, enabled, updated_at, last_test_at, last_test_result",
      )
      .eq("tenant_id", tenant.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const saved = row as unknown as {
      provider: "smtp" | "resend";
      from_name: string | null;
      from_address: string;
      reply_to: string | null;
      smtp_host: string | null;
      smtp_port: number | null;
      smtp_secure: "tls" | "starttls" | null;
      smtp_user: string | null;
      has_secret: boolean;
      enabled: boolean;
      updated_at: string;
      last_test_at: string | null;
      last_test_result: string | null;
    } | null;
    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      saved: saved && {
        provider: saved.provider,
        fromName: saved.from_name,
        fromAddress: saved.from_address,
        replyTo: saved.reply_to,
        smtpHost: saved.smtp_host,
        smtpPort: saved.smtp_port,
        smtpSecure: saved.smtp_secure,
        smtpUser: saved.smtp_user,
        hasSecret: saved.has_secret,
        enabled: saved.enabled,
        updatedAt: saved.updated_at,
        lastTestAt: saved.last_test_at,
        lastTestResult: saved.last_test_result,
      },
      envFallback: emailConfig(process.env).ok,
      canStoreSecrets: !!serverEnv().EMAIL_SETTINGS_KEY,
    };
  });

export const saveEmailSettings = createServerFn({ method: "POST" })
  .validator(z.object({ accessToken: auth, settings: emailSettingsInput }))
  .handler(async ({ data }): Promise<{ saved: true }> => {
    const caller = await signedIn(data.accessToken);
    const tenant = await adminTenant(caller);
    const s = data.settings;
    const secret = s.secret?.trim() ? s.secret.trim() : null;
    const key = serverEnv().EMAIL_SETTINGS_KEY;
    if (secret && !key) {
      throw new Error(
        "The server has no EMAIL_SETTINGS_KEY, so a password cannot be stored safely. " +
          "Ask whoever runs GrantDesk to set it.",
      );
    }
    const { error } = await caller.supabase.rpc("set_tenant_email_settings", {
      target_tenant_id: tenant.id,
      p_provider: s.provider,
      p_from_name: s.fromName,
      p_from_address: s.fromAddress,
      p_reply_to: s.replyTo,
      p_smtp_host: s.smtpHost,
      p_smtp_port: s.smtpPort,
      p_smtp_secure: s.smtpSecure,
      p_smtp_user: s.smtpUser,
      p_secret: secret,
      p_enabled: s.enabled,
      p_encryption_key: key ?? "",
    });
    if (error) {
      if (error.code === "42501") throw new Error(NOT_ADMIN);
      throw new Error(error.message);
    }
    return { saved: true };
  });

export const sendTestEmail = createServerFn({ method: "POST" })
  .validator(z.object({ accessToken: auth }))
  .handler(async ({ data }): Promise<{ ok: boolean; message: string }> => {
    const caller = await signedIn(data.accessToken);
    const tenant = await adminTenant(caller);
    if (!caller.email) throw new Error("Your account has no email address to send a test to.");
    const key = serverEnv().EMAIL_SETTINGS_KEY;
    if (!key)
      throw new Error("The server has no EMAIL_SETTINGS_KEY; saved settings cannot be read.");

    // Service role from here: only it can decrypt, and the caller has just
    // been shown to administer this tenant.
    const service = catalogWriter();
    const row = (await loadTenantSettings(service, key)).find((r) => r.tenant_id === tenant.id);
    if (!row) throw new Error("Save the settings first, then send a test.");
    const built = toTransport(row);

    const outcome = built.ok
      ? await deliver(built.transport, {
          to: caller.email,
          subject: "GrantDesk test email",
          html:
            `<p>This is a test from GrantDesk for <strong>${escapeHtml(tenant.name)}</strong>.</p>` +
            `<p>If you can read it, deadline reminders and grant alerts will be sent from this mailbox.</p>`,
          idempotencyKey: `settings-test-${tenant.id}-${Date.now()}`,
        })
      : { ok: false as const, error: built.reason };

    const message = outcome.ok
      ? `Sent to ${caller.email}. Check that inbox (and spam) to confirm it arrived.`
      : `Could not send: ${outcome.error}`;
    const { error } = await service
      .from("tenant_email_settings")
      .update({ last_test_at: new Date().toISOString(), last_test_result: message.slice(0, 500) })
      .eq("tenant_id", tenant.id);
    if (error) throw new Error(`the test ran but its result was not saved: ${error.message}`);
    return { ok: outcome.ok, message };
  });

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
