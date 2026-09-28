import type { SupabaseClient } from "@supabase/supabase-js";
import { getTenantBranding } from "@/lib/tenant";
import { decideEligibility } from "@/lib/eligibility";

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
      <div><strong>Deadline:</strong> ${deadline ? deadline : "Continuous / Open"}</div>
    </div>
    ${grantUrl ? `<a href="${grantUrl}" class="btn">View Grant in Workspace</a>` : ""}
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

  // Fetch new grants
  const { data: grants, error: grantErr } = await supabase
    .from("grants")
    .select("id, title, country, currency, amount_min, amount_max, deadline, funder:funders(name)")
    .in("id", newGrantIds);
  if (grantErr || !grants) return { queued: 0 };

  // Fetch active clients and their profiles
  const { data: clients, error: clientErr } = await supabase
    .from("clients")
    .select(
      "id, name, consultant_id, tenant_id, client_profiles(jurisdictions, sectors, stage, annual_budget, lead_time_weeks)",
    )
    .is("archived_at", null);
  if (clientErr || !clients) return { queued: 0 };

  // Fetch consultant emails
  const { data: consultants } = await supabase.from("consultants").select("id, email");
  const emailMap = new Map(
    (consultants ?? []).map((c: { id: string; email: string }) => [c.id, c.email]),
  );

  let queued = 0;
  const today = new Date();

  for (const grant of grants) {
    const funderName =
      (Array.isArray(grant.funder)
        ? (grant.funder[0] as { name?: string })?.name
        : (grant.funder as { name?: string } | null)?.name) ?? "Funding Agency";
    const amountStr = grant.amount_max
      ? `$${Number(grant.amount_max).toLocaleString()} ${grant.currency ?? "CAD"}`
      : "Disclosed in RFP";

    for (const client of clients) {
      const profile = (
        Array.isArray(client.client_profiles) ? client.client_profiles[0] : client.client_profiles
      ) as {
        jurisdictions?: string[];
        sectors?: string[];
        stage?: string | null;
        annual_budget?: number | null;
        lead_time_weeks?: number | null;
      } | null;
      if (!profile) continue;

      const decision = decideEligibility({
        grant: {
          country: grant.country,
          amountMin: grant.amount_min,
          amountMax: grant.amount_max,
          deadline: grant.deadline,
          status: "open",
        },
        client: {
          jurisdictions: profile.jurisdictions,
          stage: profile.stage,
          annualBudget: profile.annual_budget,
          leadTimeWeeks: profile.lead_time_weeks,
        },
        today,
      });

      if (decision.verdict === "eligible" || decision.verdict === "needs_input") {
        const recipientEmail = emailMap.get(client.consultant_id);
        if (!recipientEmail) continue;

        const { subject, html } = formatNewGrantEmail({
          grantTitle: grant.title,
          funderName,
          amountFormatted: amountStr,
          deadline: grant.deadline,
          clientName: client.name,
        });

        // Upsert/Insert with ignore on duplicate
        const { error: insertErr } = await supabase.from("email_outbox").insert({
          tenant_id: client.tenant_id ?? "11111111-1111-1111-1111-111111111111",
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

  // Find open proposals with deadline between today and 14 days
  const { data: proposals, error } = await supabase
    .from("proposals")
    .select(
      "id, client_id, grant:grants!inner(id, title, deadline, status), client:clients!inner(id, name, consultant_id, tenant_id)",
    )
    .gte("grant.deadline", todayStr)
    .lte("grant.deadline", horizonStr);

  if (error || !proposals) return { queued: 0 };

  const { data: consultants } = await supabase.from("consultants").select("id, email");
  const emailMap = new Map(
    (consultants ?? []).map((c: { id: string; email: string }) => [c.id, c.email]),
  );

  let queued = 0;

  for (const row of proposals) {
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
    } | null;
    if (!grant?.deadline || !client) continue;

    const daysLeft = Math.ceil((new Date(grant.deadline).getTime() - today.getTime()) / 86_400_000);
    // Send alerts at 14, 7, 3, or 1 days
    if (![14, 7, 3, 1].includes(daysLeft)) continue;

    const recipientEmail = emailMap.get(client.consultant_id);
    if (!recipientEmail) continue;

    const { subject, html } = formatDeadlineEmail({
      grantTitle: grant.title,
      clientName: client.name,
      daysLeft,
      deadline: grant.deadline,
    });

    const { error: insertErr } = await supabase.from("email_outbox").insert({
      tenant_id: client.tenant_id ?? "11111111-1111-1111-1111-111111111111",
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
