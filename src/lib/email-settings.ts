import { z } from "zod";

/**
 * Outgoing-email settings as a tenant edits them on /settings/email.
 *
 * Shared by the form (presets, validation before a round trip) and the server
 * function (the same schema, enforced again). The secret is never part of what
 * is read back: `hasSecret` says whether one is stored, nothing more.
 */

export type EmailPresetKey = "gmail" | "microsoft365" | "custom" | "resend";

export type EmailPreset = {
  key: EmailPresetKey;
  label: string;
  provider: "smtp" | "resend";
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: "tls" | "starttls";
  secretLabel: string;
  hint: string;
};

export const EMAIL_PRESETS: EmailPreset[] = [
  {
    key: "gmail",
    label: "Gmail",
    provider: "smtp",
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecure: "tls",
    secretLabel: "Google App Password",
    hint:
      "Gmail needs an App Password, not your normal password. Turn on 2-Step Verification, " +
      "then create one at myaccount.google.com/apppasswords. The username is the full Gmail address.",
  },
  {
    key: "microsoft365",
    label: "Microsoft 365",
    provider: "smtp",
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecure: "starttls",
    secretLabel: "Password",
    hint:
      "The mailbox must have Authenticated SMTP enabled in the Microsoft 365 admin center. " +
      "The username is the full email address.",
  },
  {
    key: "custom",
    label: "Custom SMTP",
    provider: "smtp",
    secretLabel: "Password",
    hint: "Use the host, port and security your mail provider documents for SMTP submission.",
  },
  {
    key: "resend",
    label: "Resend",
    provider: "resend",
    secretLabel: "Resend API key",
    hint: "The From address must be on a domain verified in Resend.",
  },
];

/** Which preset a saved configuration looks like, for reopening the form. */
export function presetFor(provider: "smtp" | "resend", smtpHost: string | null): EmailPresetKey {
  if (provider === "resend") return "resend";
  const host = smtpHost?.trim().toLowerCase();
  if (host === "smtp.gmail.com") return "gmail";
  if (host === "smtp.office365.com") return "microsoft365";
  return "custom";
}

const email = z.string().trim().email("Enter a valid email address").max(254);
const optionalEmail = z
  .string()
  .trim()
  .max(254)
  .refine((value) => value === "" || z.string().email().safeParse(value).success, {
    message: "Enter a valid email address or leave it empty",
  });

export const emailSettingsInput = z
  .object({
    provider: z.enum(["smtp", "resend"]),
    fromName: z.string().trim().max(120),
    fromAddress: email,
    replyTo: optionalEmail,
    smtpHost: z.string().trim().max(253),
    smtpPort: z.number().int().min(1).max(65535).nullable(),
    smtpSecure: z.enum(["tls", "starttls"]).nullable(),
    smtpUser: z.string().trim().max(254),
    /** Null keeps the stored secret; a string replaces it. */
    secret: z.string().max(500).nullable(),
    enabled: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.provider !== "smtp") return;
    if (!value.smtpHost)
      ctx.addIssue({ code: "custom", path: ["smtpHost"], message: "SMTP host is required" });
    if (value.smtpPort === null)
      ctx.addIssue({ code: "custom", path: ["smtpPort"], message: "SMTP port is required" });
    if (value.smtpSecure === null)
      ctx.addIssue({ code: "custom", path: ["smtpSecure"], message: "Choose TLS or STARTTLS" });
    if (!value.smtpUser)
      ctx.addIssue({ code: "custom", path: ["smtpUser"], message: "SMTP username is required" });
  });

export type EmailSettingsInput = z.infer<typeof emailSettingsInput>;

export type EmailSettingsView = {
  tenantId: string;
  tenantName: string;
  saved: {
    provider: "smtp" | "resend";
    fromName: string | null;
    fromAddress: string;
    replyTo: string | null;
    smtpHost: string | null;
    smtpPort: number | null;
    smtpSecure: "tls" | "starttls" | null;
    smtpUser: string | null;
    hasSecret: boolean;
    enabled: boolean;
    updatedAt: string;
    lastTestAt: string | null;
    lastTestResult: string | null;
  } | null;
  /** Whether the environment fallback (RESEND_API_KEY + EMAIL_FROM) is set. */
  envFallback: boolean;
  /** Whether the server can encrypt a new secret at all. */
  canStoreSecrets: boolean;
};

/** "Name <address>", with the name quoted when it needs to be. */
export function formatFrom(name: string | null | undefined, address: string): string {
  const trimmed = name?.trim();
  if (!trimmed) return address;
  const safe = trimmed.replace(/["\\\r\n]/g, "");
  return /[(),.:;<>@[\]]/.test(safe) ? `"${safe}" <${address}>` : `${safe} <${address}>`;
}
