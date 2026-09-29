import { describe, expect, it } from "vitest";
import {
  buildDeadlineWebhookPayload,
  formatDeadlineEmail,
  formatNewGrantEmail,
  formatReportDueEmail,
} from "./notifications";

describe("notifications formatting and logic", () => {
  it("formats new grant email with high fidelity and tenant branding", () => {
    const { subject, html } = formatNewGrantEmail({
      grantTitle: "Clean Energy Innovation Fund",
      funderName: "Natural Resources Canada",
      amountFormatted: "$150,000 CAD",
      deadline: "2026-11-30",
      clientName: "GreenTech Solutions",
      tenantSlug: "iial",
      grantUrl: "https://iial.grantdesk.app/catalog",
    });

    expect(subject).toContain("GreenTech Solutions");
    expect(subject).toContain("Clean Energy Innovation Fund");
    expect(html).toContain("Natural Resources Canada");
    expect(html).toContain("$150,000 CAD");
    expect(html).toContain("2026-11-30");
    expect(html).toContain("IIAL Grant Alert");
  });

  it("formats deadline reminder with urgency emoji and countdown", () => {
    const urgent = formatDeadlineEmail({
      grantTitle: "AI Workforce Expansion Grant",
      clientName: "DeepTech AI",
      daysLeft: 3,
      deadline: "2026-09-25",
    });

    expect(urgent.subject).toContain("🚨");
    expect(urgent.subject).toContain("3d");
    expect(urgent.html).toContain("3 Days Remaining");

    const upcoming = formatDeadlineEmail({
      grantTitle: "Community Health Grant",
      clientName: "HealthOrg",
      daysLeft: 14,
      deadline: "2026-10-05",
    });

    expect(upcoming.subject).toContain("14d");
    expect(upcoming.html).toContain("14 Days Remaining");
  });

  it("formats an award report reminder and escapes funder text", () => {
    const { subject, html } = formatReportDueEmail({
      grantTitle: "Skills <Fund>",
      clientName: "HealthOrg",
      reportLabel: "Year 1 interim",
      kind: "interim",
      daysLeft: 7,
      dueOn: "2026-10-06",
    });
    expect(subject).toContain("Report due in 7d");
    expect(html).toContain("Interim report");
    expect(html).toContain("Skills &lt;Fund&gt;");
    expect(html).not.toContain("<Fund>");
  });
});

describe("buildDeadlineWebhookPayload", () => {
  it("is a bare {text} that Slack and Teams both accept", () => {
    const payload = buildDeadlineWebhookPayload({
      grantTitle: "Community Health Grant",
      clientName: "HealthOrg",
      daysLeft: 7,
      deadline: "2026-10-05",
      link: "https://iial.grantdesk.app/clients/c/proposals/g",
    });
    expect(Object.keys(payload)).toEqual(["text"]);
    expect(payload.text).toBe(
      "GrantDesk: 7 days left for HealthOrg — Community Health Grant (closes 2026-10-05). " +
        "https://iial.grantdesk.app/clients/c/proposals/g",
    );
  });

  it("says 1 day, strips markup and refuses non-https links", () => {
    const { text } = buildDeadlineWebhookPayload({
      grantTitle: "<script>x</script>  Fund\n",
      clientName: "<!channel> Org",
      daysLeft: 1,
      deadline: "2026-10-01",
      link: "javascript:alert(1)",
    });
    expect(text).toBe(
      "GrantDesk: 1 day left for !channel Org — scriptx/script Fund (closes 2026-10-01).",
    );
    expect(text).not.toMatch(/[<>]/);
  });
});
