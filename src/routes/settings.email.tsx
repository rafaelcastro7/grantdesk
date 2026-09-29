import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useId, useState, type ReactNode } from "react";
import {
  EMAIL_PRESETS,
  emailSettingsInput,
  presetFor,
  type EmailPresetKey,
  type EmailSettingsView,
} from "@/lib/email-settings";
import { errorMessage } from "@/lib/error-message";
import { accessToken } from "@/lib/session";
import { useAction } from "@/lib/use-action";
import { useDocumentTitle } from "@/lib/use-document-title";
import { useRequireSession } from "@/lib/use-require-session";
import {
  getEmailSettings,
  saveEmailSettings,
  sendTestEmail,
} from "@/server/email-settings.functions";

export const Route = createFileRoute("/settings/email")({ component: EmailSettingsPage });

type Form = {
  preset: EmailPresetKey;
  fromName: string;
  fromAddress: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: "tls" | "starttls";
  smtpUser: string;
  enabled: boolean;
};

const EMPTY: Form = {
  preset: "gmail",
  fromName: "",
  fromAddress: "",
  replyTo: "",
  smtpHost: "smtp.gmail.com",
  smtpPort: "465",
  smtpSecure: "tls",
  smtpUser: "",
  enabled: true,
};

function fromView(view: EmailSettingsView): Form {
  const s = view.saved;
  if (!s) return EMPTY;
  return {
    preset: presetFor(s.provider, s.smtpHost),
    fromName: s.fromName ?? "",
    fromAddress: s.fromAddress,
    replyTo: s.replyTo ?? "",
    smtpHost: s.smtpHost ?? "",
    smtpPort: s.smtpPort ? String(s.smtpPort) : "",
    smtpSecure: s.smtpSecure ?? "tls",
    smtpUser: s.smtpUser ?? "",
    enabled: s.enabled,
  };
}

const inputClass =
  "mt-1 w-full rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2 text-sm";

/**
 * Who reminders and alerts come from, editable by a workspace owner or admin.
 *
 * Moving from a personal Gmail to the organisation's own mailbox is an edit
 * and a Save here. The password is write-only: the page learns whether one is
 * stored, never what it is.
 */
function EmailSettingsPage() {
  useDocumentTitle("Email settings");
  useRequireSession();
  const load = useServerFn(getEmailSettings);
  const save = useServerFn(saveEmailSettings);
  const test = useServerFn(sendTestEmail);
  const action = useAction();
  const [view, setView] = useState<EmailSettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [replacing, setReplacing] = useState(false);
  const [secret, setSecret] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function refresh() {
    const next = await load({ data: { accessToken: await accessToken() } });
    setView(next);
    setForm(fromView(next));
    setReplacing(!next.saved?.hasSecret);
    setSecret("");
  }

  useEffect(() => {
    void refresh().catch((caught) => setLoadError(errorMessage(caught)));
  }, []);

  const preset = EMAIL_PRESETS.find((p) => p.key === form.preset)!;
  const isSmtp = preset.provider === "smtp";
  const savedProvider = view?.saved?.provider;
  // A stored secret belongs to its provider; switching needs a new one.
  const secretKept = !!view?.saved?.hasSecret && savedProvider === preset.provider && !replacing;

  function choosePreset(key: EmailPresetKey) {
    const next = EMAIL_PRESETS.find((p) => p.key === key)!;
    setForm((f) => ({
      ...f,
      preset: key,
      smtpHost: next.smtpHost ?? (key === "custom" ? "" : f.smtpHost),
      smtpPort: next.smtpPort ? String(next.smtpPort) : key === "custom" ? "" : f.smtpPort,
      smtpSecure: next.smtpSecure ?? f.smtpSecure,
    }));
    if (view?.saved?.provider !== next.provider) setReplacing(true);
  }

  function onSave() {
    void action.run("save", async () => {
      const candidate = {
        provider: preset.provider,
        fromName: form.fromName,
        fromAddress: form.fromAddress,
        replyTo: form.replyTo,
        smtpHost: isSmtp ? form.smtpHost : "",
        smtpPort: isSmtp && form.smtpPort ? Number(form.smtpPort) : null,
        smtpSecure: isSmtp ? form.smtpSecure : null,
        smtpUser: isSmtp ? (form.smtpUser || form.fromAddress).trim() : "",
        secret: secretKept ? null : secret,
        enabled: form.enabled,
      };
      const parsed = emailSettingsInput.safeParse(candidate);
      const errors: Record<string, string> = {};
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const key = String(issue.path[0] ?? "form");
          errors[key] ??= issue.message;
        }
      }
      if (!secretKept && !secret.trim()) errors.secret = `${preset.secretLabel} is required`;
      setFieldErrors(errors);
      if (Object.keys(errors).length > 0 || !parsed.success) {
        throw new Error("Some fields need attention.");
      }
      await save({ data: { accessToken: await accessToken(), settings: parsed.data } });
      setTestResult(null);
      await refresh();
      return form.enabled
        ? "Saved. Reminders will be sent from this mailbox."
        : "Saved, but sending is turned off.";
    });
  }

  function onTest() {
    void action.run("test", async () => {
      setTestResult(null);
      const result = await test({ data: { accessToken: await accessToken() } });
      setTestResult(result);
      await refresh();
    });
  }

  if (loadError) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Email settings</h1>
        <p role="alert" className="mt-6 text-sm text-[var(--color-ineligible)]">
          {loadError}
        </p>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12">
        <p className="text-sm text-[var(--color-ink-soft)]">Loading…</p>
      </main>
    );
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(fromView(view)) || !!secret;

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Email settings</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-ink-soft)]">
        The mailbox {view.tenantName} sends deadline reminders and grant alerts from. Change it at
        any time — for example from a personal Gmail to the organisation&apos;s own account — by
        editing and saving.
      </p>
      {!view.saved && (
        <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
          {view.envFallback
            ? "Nothing saved yet: email currently goes out through the server's default sender."
            : "Nothing saved yet, and the server has no default sender, so no email is sent."}
        </p>
      )}
      {!view.canStoreSecrets && (
        <p role="alert" className="mt-3 text-sm text-[var(--color-needs-input)]">
          The server has no EMAIL_SETTINGS_KEY, so a password cannot be saved yet.
        </p>
      )}

      <form
        className="mt-8 flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
        noValidate
      >
        <fieldset>
          <legend className="text-sm font-medium">Provider</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {EMAIL_PRESETS.map((p) => (
              <label
                key={p.key}
                className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${
                  form.preset === p.key
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                    : "border-[var(--color-rule)]"
                }`}
              >
                <input
                  type="radio"
                  name="preset"
                  value={p.key}
                  checked={form.preset === p.key}
                  onChange={() => choosePreset(p.key)}
                  className="sr-only"
                />
                {p.label}
              </label>
            ))}
          </div>
          <p data-testid="preset-hint" className="mt-2 text-xs text-[var(--color-ink-soft)]">
            {preset.hint}
          </p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From name" error={fieldErrors.fromName}>
            {(id, describedBy) => (
              <input
                id={id}
                aria-describedby={describedBy}
                className={inputClass}
                value={form.fromName}
                placeholder="IIAL Grants"
                onChange={(e) => setForm({ ...form, fromName: e.target.value })}
              />
            )}
          </Field>
          <Field label="From address" error={fieldErrors.fromAddress} required>
            {(id, describedBy) => (
              <input
                id={id}
                type="email"
                autoComplete="email"
                required
                aria-invalid={!!fieldErrors.fromAddress}
                aria-describedby={describedBy}
                className={inputClass}
                value={form.fromAddress}
                onChange={(e) => setForm({ ...form, fromAddress: e.target.value })}
              />
            )}
          </Field>
          <Field label="Reply-to (optional)" error={fieldErrors.replyTo}>
            {(id, describedBy) => (
              <input
                id={id}
                type="email"
                aria-invalid={!!fieldErrors.replyTo}
                aria-describedby={describedBy}
                className={inputClass}
                value={form.replyTo}
                onChange={(e) => setForm({ ...form, replyTo: e.target.value })}
              />
            )}
          </Field>
        </div>

        {isSmtp && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="SMTP host" error={fieldErrors.smtpHost} required>
              {(id, describedBy) => (
                <input
                  id={id}
                  required
                  aria-invalid={!!fieldErrors.smtpHost}
                  aria-describedby={describedBy}
                  className={inputClass}
                  value={form.smtpHost}
                  onChange={(e) => setForm({ ...form, smtpHost: e.target.value })}
                />
              )}
            </Field>
            <Field label="Port" error={fieldErrors.smtpPort} required>
              {(id, describedBy) => (
                <input
                  id={id}
                  inputMode="numeric"
                  required
                  aria-invalid={!!fieldErrors.smtpPort}
                  aria-describedby={describedBy}
                  className={inputClass}
                  value={form.smtpPort}
                  onChange={(e) =>
                    setForm({ ...form, smtpPort: e.target.value.replace(/[^0-9]/g, "") })
                  }
                />
              )}
            </Field>
            <Field label="Security" error={fieldErrors.smtpSecure}>
              {(id, describedBy) => (
                <select
                  id={id}
                  aria-describedby={describedBy}
                  className={inputClass}
                  value={form.smtpSecure}
                  onChange={(e) =>
                    setForm({ ...form, smtpSecure: e.target.value as "tls" | "starttls" })
                  }
                >
                  <option value="tls">TLS (usually port 465)</option>
                  <option value="starttls">STARTTLS (usually port 587)</option>
                </select>
              )}
            </Field>
            <Field
              label="Username"
              error={fieldErrors.smtpUser}
              hint="Usually the full email address. Left empty, the From address is used."
            >
              {(id, describedBy) => (
                <input
                  id={id}
                  autoComplete="username"
                  aria-invalid={!!fieldErrors.smtpUser}
                  aria-describedby={describedBy}
                  className={inputClass}
                  value={form.smtpUser}
                  placeholder={form.fromAddress}
                  onChange={(e) => setForm({ ...form, smtpUser: e.target.value })}
                />
              )}
            </Field>
          </div>
        )}

        <div>
          {secretKept ? (
            <div>
              <span className="text-sm font-medium">{preset.secretLabel}</span>
              <div className="mt-1 flex items-center gap-3">
                <span data-testid="secret-saved" className="font-mono text-sm">
                  •••• saved
                </span>
                <button
                  type="button"
                  onClick={() => setReplacing(true)}
                  className="rounded-md border border-[var(--color-rule)] px-3 py-1 text-sm"
                >
                  Replace
                </button>
              </div>
            </div>
          ) : (
            <Field label={preset.secretLabel} error={fieldErrors.secret} required>
              {(id, describedBy) => (
                <div className="flex items-center gap-2">
                  <input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    required
                    aria-invalid={!!fieldErrors.secret}
                    aria-describedby={describedBy}
                    className={inputClass}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                  {view.saved?.hasSecret && savedProvider === preset.provider && (
                    <button
                      type="button"
                      onClick={() => {
                        setReplacing(false);
                        setSecret("");
                      }}
                      className="mt-1 rounded-md px-3 py-2 text-sm text-[var(--color-ink-soft)]"
                    >
                      Keep saved
                    </button>
                  )}
                </div>
              )}
            </Field>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Send email from this mailbox
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={action.busy !== null}
            className="rounded-md bg-[var(--color-accent-strong)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {action.busy === "save" ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={onTest}
            disabled={action.busy !== null || !view.saved || dirty}
            title={dirty ? "Save your changes first" : undefined}
            className="rounded-md border border-[var(--color-rule)] px-4 py-2 text-sm font-medium disabled:opacity-60"
          >
            {action.busy === "test" ? "Sending…" : "Send test email"}
          </button>
          {dirty && view.saved && (
            <span className="text-xs text-[var(--color-ink-soft)]">
              Save your changes before testing.
            </span>
          )}
        </div>

        <div aria-live="polite">
          {action.error && (
            <p role="alert" className="text-sm text-[var(--color-ineligible)]">
              {action.error}
            </p>
          )}
          {action.note && <p className="text-sm text-[var(--color-eligible)]">{action.note}</p>}
          {testResult && (
            <p
              data-testid="test-result"
              className={`text-sm ${
                testResult.ok ? "text-[var(--color-eligible)]" : "text-[var(--color-ineligible)]"
              }`}
            >
              {testResult.message}
            </p>
          )}
          {!testResult && view.saved?.lastTestAt && (
            <p className="text-xs text-[var(--color-ink-soft)]">
              Last test {new Date(view.saved.lastTestAt).toLocaleString()}:{" "}
              {view.saved.lastTestResult}
            </p>
          )}
        </div>
      </form>
    </main>
  );
}

function Field({
  label,
  error,
  hint,
  required,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {children(id, describedBy || undefined)}
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-[var(--color-ink-soft)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-xs text-[var(--color-ineligible)]">
          {error}
        </p>
      )}
    </div>
  );
}
