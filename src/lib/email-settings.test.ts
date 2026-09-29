import { describe, expect, it } from "vitest";
import { EMAIL_PRESETS, emailSettingsInput, formatFrom, presetFor } from "./email-settings";

const valid = {
  provider: "smtp" as const,
  fromName: "IIAL Grants",
  fromAddress: "me@gmail.com",
  replyTo: "",
  smtpHost: "smtp.gmail.com",
  smtpPort: 465,
  smtpSecure: "tls" as const,
  smtpUser: "me@gmail.com",
  secret: null,
  enabled: true,
};

describe("email presets", () => {
  it("Gmail is TLS on 465 and says it needs an App Password with 2-Step Verification", () => {
    const gmail = EMAIL_PRESETS.find((p) => p.key === "gmail")!;
    expect(gmail).toMatchObject({ smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecure: "tls" });
    expect(gmail.hint).toMatch(/App Password/);
    expect(gmail.hint).toMatch(/2-Step/);
  });
  it("Microsoft 365 is STARTTLS on 587", () => {
    expect(EMAIL_PRESETS.find((p) => p.key === "microsoft365")).toMatchObject({
      smtpHost: "smtp.office365.com",
      smtpPort: 587,
      smtpSecure: "starttls",
    });
  });
  it("recognises a saved configuration's preset", () => {
    expect(presetFor("smtp", "SMTP.gmail.com")).toBe("gmail");
    expect(presetFor("smtp", "smtp.office365.com")).toBe("microsoft365");
    expect(presetFor("smtp", "mail.iial.ca")).toBe("custom");
    expect(presetFor("resend", null)).toBe("resend");
  });
});

describe("emailSettingsInput", () => {
  it("accepts a complete SMTP configuration", () => {
    expect(emailSettingsInput.safeParse(valid).success).toBe(true);
  });
  it("requires host, port, security and user for SMTP", () => {
    const result = emailSettingsInput.safeParse({
      ...valid,
      smtpHost: "",
      smtpPort: null,
      smtpSecure: null,
      smtpUser: "",
    });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path[0]);
    expect(paths).toEqual(
      expect.arrayContaining(["smtpHost", "smtpPort", "smtpSecure", "smtpUser"]),
    );
  });
  it("does not require SMTP fields for Resend", () => {
    const resend = {
      ...valid,
      provider: "resend" as const,
      smtpHost: "",
      smtpPort: null,
      smtpSecure: null,
      smtpUser: "",
    };
    expect(emailSettingsInput.safeParse(resend).success).toBe(true);
  });
  it("rejects a malformed from or reply-to address", () => {
    expect(emailSettingsInput.safeParse({ ...valid, fromAddress: "nope" }).success).toBe(false);
    expect(emailSettingsInput.safeParse({ ...valid, replyTo: "nope" }).success).toBe(false);
  });
});

describe("formatFrom", () => {
  it("combines name and address, quoting when needed and dropping header breaks", () => {
    expect(formatFrom(null, "a@b.co")).toBe("a@b.co");
    expect(formatFrom("IIAL Grants", "a@b.co")).toBe("IIAL Grants <a@b.co>");
    expect(formatFrom("IIAL, Inc.", "a@b.co")).toBe('"IIAL, Inc." <a@b.co>');
    expect(formatFrom('Evil"\r\nBcc: x', "a@b.co")).toBe('"EvilBcc: x" <a@b.co>');
  });
});
