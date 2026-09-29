import type { SupabaseClient } from "@supabase/supabase-js";
import { getTenantBranding } from "@/lib/tenant";
import { decideEligibility } from "@/lib/eligibility";
import { daysUntilDeadline } from "@/lib/deadline";
import { formatMoney } from "@/lib/money";

/** Funder text goes into HTML email; it must never be able to become markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? escapeHtml(parsed.toString()) : null;
  } catch {
    return null;
  }
}

export interface EmailOutboxRow {
  id?: string;
  tenant_id?: string;
  recipient_email: string;
  subject: string;
  body_html: string;
  kind: "new_grant_match" | "deadline_reminder" | "system_alert";
  grant_id?: string | null;
  client_id?: string | null;
  status?: "pending" | "sent" | "failed";
}

/**
 * Creates HTML template for a newly discovered grant matching a client.
 */
export function formatNewGrantEmail({
  grantTitle,
  funderName,
  amountFormatted,
  deadline,
  clientName,
  tenantSlug = "iial",
  grantUrl,
}: {
  grantTitle: string;
  funderName: string;
  amountFormatted: string;
  deadline: string | null;
  clientName: string;
  tenantSlug?: string;
  grantUrl?: string;
}): { subject: string; html: string } {
  const branding = getTenantBranding(tenantSlug);
  const subject = `[GrantDesk] New Matched Grant for ${clientName}: ${grantTitle}`;
  grantTitle = escapeHtml(grantTitle);
  funderName = escapeHtml(funderName);
  clientName = escapeHtml(clientName);
  amountFormatted = escapeHtml(amountFormatted);
  const link = safeUrl(grantUrl);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #1e293b; margin: 0; padding: 24px; background: #f8fafc; }
    .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; padding: 28px; }
    .header { border-bottom: 2px solid ${branding.primaryColor}; padding-bottom: 12px; margin-bottom: 20px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; background: #e0f2fe; color: #0369a1; }
    .title { font-size: 18px; font-weight: 700; color: #0f172a; margin: 12px 0 6px 0; }
    .funder { color: #64748b; font-size: 14px; margin-bottom: 16px; }
    .details { background: #f1f5f9; border-radius: 6px; padding: 14px; margin: 16px 0; font-size: 14px; }
    .btn { display: inline-block; padding: 10px 20px; border-radius: 6px; background: ${branding.primaryColor}; color: #ffffff !important; text-decoration: none; font-weight: 600; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <span class="badge">${branding.shortName} Grant Alert</span>
    </div>
    <div class="title">${grantTitle}</div>
    <div class="funder">Funder: <strong>${funderName}</strong></div>
    <p>A new funding opportunity was discovered and matches the profile of <strong>${clientName}</strong>:</p>
    <div class="details">
      <div><strong>Funding Amount:</strong> ${amountFormatted}</div>
      <div><strong>Deadline:</strong> ${deadline ? escapeHtml(deadline) : "No closing date published"}</div>
    </div>
    ${link ? `<a href="${link}" class="btn">Open the call</a>` : ""}
  </div>
</body>
</html>
`;

  return { subject, html };
}

/**
 * Creates HTML template for an impending deadline reminder.
 */
export function formatDeadlineEmail({
  grantTitle,
  clientName,
  daysLeft,
  deadline,
  tenantSlug = "iial",
}: {
  grantTitle: string;
  clientName: string;
  daysLeft: number;
  deadline: string;
  tenantSlug?: string;
}): { subject: string; html: string } {
  const branding = getTenantBranding(tenantSlug);
  const urgencyLabel =
    daysLeft <= 1
      ? "🚨 Final Day"
      : daysLeft <= 3
        ? "🚨 Urgent"
        : daysLeft <= 7
          ? "⚠️ Attention"
          : "📅 Upcoming";
  const subject = `[${branding.shortName}] ${urgencyLabel}: ${daysLeft}d left for ${clientName} - ${grantTitle}`;
  grantTitle = escapeHtml(grantTitle);
  clientName = escapeHtml(clientName);
  deadline = escapeHtml(deadline);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #1e293b; margin: 0; padding: 24px; background: #f8fafc; }
    .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; padding: 28px; }
    .urgency { font-size: 13px; font-weight: 700; color: ${daysLeft <= 3 ? "#e11d48" : "#d97706"}; text-transform: uppercase; }
    .title { font-size: 18px; font-weight: 700; color: #0f172a; margin: 8px 0; }
    .notice { background: ${daysLeft <= 3 ? "#fff1f2" : "#fefce8"}; border-left: 4px solid ${daysLeft <= 3 ? "#f43f5e" : "#eab308"}; padding: 12px; margin: 16px 0; }
  </style>
</head>
<body>
  <div class="card">
    <div style="margin-bottom: 12px; font-size: 12px; font-weight: 600; color: ${branding.primaryColor};">${branding.name}</div>
    <div class="urgency">${daysLeft} Days Remaining</div>
    <div class="title">${grantTitle}</div>
    <p>This is an automated deadline reminder for <strong>${clientName}</strong>.</p>
    <div class="notice">
      Application closing date: <strong>${deadline}</strong>. Ensure all required sections and checklist items are completed.
    </div>
  </div>
</body>
</html>
`;

  return { subject, html };
}

/**
 * Scans newly ingested grants, computes eligibility against active clients,
 * and queues email alerts into email_outbox without duplication.
 */
export async function scanAndAlertNewGrants({
  supabase,
  newGrantIds,
}: {
  supabase: SupabaseClient;
  newGrantIds: string[];
}): Promise<{ queued: number }> {
  if (!newGrantIds.length) return { queued: 0 };

  // Every field the rules engine reads, so an alert means what a match means.
  const { data: grants, error: grantErr } = await supabase
    .from("grants")
    .select(
      "id, title, summary, url, country, currency, amount_min, amount_max, deadline, status, " +
        "eligible_applicant_types, eligibility_note, funder:funders(name)",
    )
    .in("id", newGrantIds);
  if (grantErr) throw new Error(`alert scan could not read grants: ${grantErr.message}`);
  if (!grants) return { queued: 0 };

  const { data: clients, error: clientErr } = await supabase
    .from("clients")
    .select(
      "id, name, consultant_id, tenant_id, tenant:tenants(slug), client_profiles(jurisdictions, " +
        "sectors, stage, annual_budget, currency, lead_time_weeks, funded_partner_pathway, " +
        "partner_lead_time_weeks, capability_domains)",
    )
    .is("archived_at", null);
  if (clientErr) throw new Error(`alert scan could not read clients: ${clientErr.message}`);
  if (!clients) return { queued: 0 };

  // Fetch consultant emails
  const { data: consultants } = await supabase.from("consultants").select("id, email");
  const emailMap = new Map(
    (consultants ?? []).map((c: { id: string; email: string }) => [c.id, c.email]),
  );

  let queued = 0;
  const today = new Date();

  type GrantRow = {
    id: string;
    title: string;
    summary: string | null;
    url: string;
    country: string;
    currency: string | null;
    amount_min: number | null;
    amount_max: number | null;
    deadline: string | null;
    status: string | null;
    eligible_applicant_types: string[] | null;
    eligibility_note: string | null;
    funder: { name?: string } | Array<{ name?: string }> | null;
  };
  type ClientRow = {
    id: string;
    name: string;
    consultant_id: string;
    tenant_id: string | null;
    tenant: { slug: string } | Array<{ slug: string }> | null;
    client_profiles: ProfileRow | ProfileRow[] | null;
  };
  type ProfileRow = {
    jurisdictions?: string[];
    stage?: string | null;
    annual_budget?: number | null;
    currency?: string | null;
    lead_time_weeks?: number | null;
    funded_partner_pathway?: boolean | null;
    partner_lead_time_weeks?: number | null;
    capability_domains?: string[] | null;
  };
  const one = <T>(value: T | T[] | null): T | null =>
    Array.isArray(value) ? (value[0] ?? null) : value;

  for (const grant of grants as unknown as GrantRow[]) {
    const funderName = one(grant.funder)?.name ?? "Funder not published";
    const amountStr = grant.amount_max
      ? `Up to ${formatMoney(Number(grant.amount_max), grant.currency)}`
      : grant.amount_min
        ? `From ${formatMoney(Number(grant.amount_min), grant.currency)}`
        : "Amount not published";

    for (const client of clients as unknown as ClientRow[]) {
      const profile = one(client.client_profiles);
      const tenantSlug = one(client.tenant)?.slug;
      // No tenant means no branding and no isolation to send under; skipping
      // is right, guessing a default tenant would mail under someone else's name.
      if (!profile || !client.tenant_id || !tenantSlug) continue;

      const decision = decideEligibility({
        grant: {
          title: grant.title,
          summary: grant.summary,
          country: grant.country,
          currency: grant.currency,
          amountMin: grant.amount_min,
          amountMax: grant.amount_max,
          deadline: grant.deadline,
          status: grant.status,
          eligibleApplicantTypes: grant.eligible_applicant_types ?? [],
          eligibilityNote: grant.eligibility_note,
        },
        client: {
          jurisdictions: profile.jurisdictions,
          stage: profile.stage,
          annualBudget: profile.annual_budget,
          currency: profile.currency,
          leadTimeWeeks: profile.lead_time_weeks,
          fundedPartnerPathway: profile.funded_partner_pathway,
          partnerLeadTimeWeeks: profile.partner_lead_time_weeks,
          capabilityDomains: profile.capability_domains,
        },
        today,
      });

      // Only a verdict the rules stand behind is worth an email. A
      // needs-input result is a question for the screen, not the inbox.
      if (decision.verdict === "eligible") {
        const recipientEmail = emailMap.get(client.consultant_id);
        if (!recipientEmail) continue;

        const { subject, html } = formatNewGrantEmail({
          grantTitle: grant.title,
          funderName,
          amountFormatted: amountStr,
          deadline: grant.deadline,
          clientName: client.name,
          tenantSlug,
          grantUrl: grant.url,
        });

        // Duplicates are rejected by the daily dedup index, which is the point.
        const { error: insertErr } = await supabase.from("email_outbox").insert({
          tenant_id: client.tenant_id,
          recipient_email: recipientEmail,
          subject,
          body_html: html,
          kind: "new_grant_match",
          grant_id: grant.id,
          client_id: client.id,
          status: "pending",
        });

        if (!insertErr) queued++;
      }
    }
  }

  return { queued };
}

/**
 * Evaluates impending deadlines (e.g. 14d, 7d, 3d, 1d) and queues alerts.
 */
export async function scanAndAlertDeadlines({
  supabase,
  today = new Date(),
}: {
  supabase: SupabaseClient;
  today?: Date;
}): Promise<{ queued: number }> {
  const horizonDate = new Date(today.getTime() + 15 * 86_400_000);
  const todayStr = today.toISOString().slice(0, 10);
  const horizonStr = horizonDate.toISOString().slice(0, 10);

  // Only live work: something drafted or decided, not sent, not a no-go.
  const [{ data: proposals, error }, { data: decisions, error: decisionError }] = await Promise.all(
    [
      supabase
        .from("proposals")
        .select(
          "id, client_id, grant_id, grant:grants!inner(id, title, deadline, status), " +
            "client:clients!inner(id, name, consultant_id, tenant_id, tenant:tenants(slug)), " +
            "submissions(id), proposal_sections(id)",
        )
        .gte("grant.deadline", todayStr)
        .lte("grant.deadline", horizonStr),
      supabase.from("opportunity_decisions").select("client_id, grant_id, decision"),
    ],
  );
  if (error) throw new Error(`reminder scan could not read proposals: ${error.message}`);
  if (decisionError)
    throw new Error(`reminder scan could not read decisions: ${decisionError.message}`);
  if (!proposals) return { queued: 0 };
  const decisionOf = new Map(
    ((decisions ?? []) as Array<{ client_id: string; grant_id: string; decision: string }>).map(
      (d) => [`${d.client_id}|${d.grant_id}`, d.decision],
    ),
  );

  const { data: consultants } = await supabase.from("consultants").select("id, email");
  const emailMap = new Map(
    (consultants ?? []).map((c: { id: string; email: string }) => [c.id, c.email]),
  );

  let queued = 0;

  for (const row of proposals as unknown as Array<{
    client_id: string;
    grant_id: string;
    grant: unknown;
    client: unknown;
    submissions: Array<{ id: string }> | null;
    proposal_sections: Array<{ id: string }> | null;
  }>) {
    const decision = decisionOf.get(`${row.client_id}|${row.grant_id}`);
    if ((row.submissions ?? []).length > 0 || decision === "no_go") continue;
    if ((row.proposal_sections ?? []).length === 0 && !decision) continue;
    const grant = (Array.isArray(row.grant) ? row.grant[0] : row.grant) as {
      id: string;
      title: string;
      deadline: string | null;
      status: string;
    } | null;
    const client = (Array.isArray(row.client) ? row.client[0] : row.client) as {
      id: string;
      name: string;
      consultant_id: string;
      tenant_id: string | null;
      tenant: { slug: string } | Array<{ slug: string }> | null;
    } | null;
    if (!grant?.deadline || !client?.tenant_id) continue;
    const tenantSlug = (Array.isArray(client.tenant) ? client.tenant[0] : client.tenant)?.slug;
    if (!tenantSlug || (grant.status && grant.status !== "open")) continue;

    const daysLeft = daysUntilDeadline(grant.deadline, today);
    // Send alerts at 14, 7, 3, or 1 days
    if (![14, 7, 3, 1].includes(daysLeft)) continue;

    const recipientEmail = emailMap.get(client.consultant_id);
    if (!recipientEmail) continue;

    const { subject, html } = formatDeadlineEmail({
      grantTitle: grant.title,
      clientName: client.name,
      daysLeft,
      deadline: grant.deadline,
      tenantSlug,
    });

    const { error: insertErr } = await supabase.from("email_outbox").insert({
      tenant_id: client.tenant_id,
      recipient_email: recipientEmail,
      subject,
      body_html: html,
      kind: "deadline_reminder",
      grant_id: grant.id,
      client_id: client.id,
      status: "pending",
    });

    if (!insertErr) queued++;
  }

  return { queued };
}
