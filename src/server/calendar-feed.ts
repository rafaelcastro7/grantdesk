import type { SupabaseClient } from "@supabase/supabase-js";
import { buildIcs } from "@/lib/ics";
import {
  feedEvents,
  hashCalendarToken,
  isWellFormedToken,
  type FeedRow,
} from "@/lib/calendar-feed";

/**
 * The subscribable deadline feed. A calendar app fetches this with no session,
 * so the token is the only credential and the read is service-role. Every
 * query below is therefore narrowed by hand to what owns_client() would allow
 * that one consultant — owned or team clients, inside their own tenants — and
 * nothing else in this file may widen it.
 */
export async function calendarFeedResponse(
  supabase: SupabaseClient,
  token: string,
  origin: string,
  now = new Date(),
): Promise<Response> {
  const notFound = () =>
    new Response("This calendar link is not valid or was revoked.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  if (!isWellFormedToken(token)) return notFound();

  const { data: tokenRow, error: tokenError } = await supabase
    .from("calendar_tokens")
    .select("consultant_id")
    .eq("token_hash", await hashCalendarToken(token))
    .is("revoked_at", null)
    .maybeSingle();
  if (tokenError) throw new Error(`could not read calendar token: ${tokenError.message}`);
  if (!tokenRow) return notFound();
  const consultantId = (tokenRow as { consultant_id: string }).consultant_id;

  const [tenants, owned, team] = await Promise.all([
    supabase.from("tenant_members").select("tenant_id").eq("user_id", consultantId),
    supabase.from("clients").select("id, tenant_id").eq("consultant_id", consultantId),
    supabase.from("client_team_members").select("client_id").eq("user_id", consultantId),
  ]);
  const readError = tenants.error ?? owned.error ?? team.error;
  if (readError) throw new Error(`could not read the consultant's clients: ${readError.message}`);

  const tenantIds = new Set(
    ((tenants.data ?? []) as Array<{ tenant_id: string }>).map((t) => t.tenant_id),
  );
  const teamIds = ((team.data ?? []) as Array<{ client_id: string }>).map((t) => t.client_id);
  const candidates = [...((owned.data ?? []) as Array<{ id: string; tenant_id: string }>)];
  for (let i = 0; i < teamIds.length; i += 50) {
    const { data, error } = await supabase
      .from("clients")
      .select("id, tenant_id")
      .in("id", teamIds.slice(i, i + 50));
    if (error) throw new Error(`could not read team clients: ${error.message}`);
    candidates.push(...((data ?? []) as Array<{ id: string; tenant_id: string }>));
  }
  const clientIds = [
    ...new Set(candidates.filter((c) => tenantIds.has(c.tenant_id)).map((c) => c.id)),
  ];

  const rows: FeedRow[] = [];
  for (let i = 0; i < clientIds.length; i += 50) {
    const chunk = clientIds.slice(i, i + 50);
    const [proposals, decisions] = await Promise.all([
      supabase
        .from("proposals")
        .select(
          "id, client_id, grant_id, clients(name), grants(title, deadline, estimated_deadline), " +
            "submissions(id), proposal_sections(id)",
        )
        .in("client_id", chunk),
      supabase
        .from("opportunity_decisions")
        .select("client_id, grant_id, decision")
        .in("client_id", chunk),
    ]);
    const error = proposals.error ?? decisions.error;
    if (error) throw new Error(`could not read proposals for the feed: ${error.message}`);
    const decisionOf = new Map(
      (
        (decisions.data ?? []) as Array<{ client_id: string; grant_id: string; decision: string }>
      ).map((d) => [`${d.client_id}|${d.grant_id}`, d.decision]),
    );
    type Joined = {
      id: string;
      client_id: string;
      grant_id: string;
      clients: { name: string } | null;
      grants: { title: string; deadline: string | null; estimated_deadline: string | null } | null;
      submissions: unknown[] | null;
      proposal_sections: unknown[] | null;
    };
    for (const p of (proposals.data ?? []) as unknown as Joined[]) {
      rows.push({
        id: p.id,
        client_id: p.client_id,
        grant_id: p.grant_id,
        clientName: p.clients?.name ?? "Client",
        title: p.grants?.title ?? "Application",
        deadline: p.grants?.deadline ?? null,
        estimatedDeadline: p.grants?.estimated_deadline ?? null,
        decision: decisionOf.get(`${p.client_id}|${p.grant_id}`) ?? null,
        submissions: p.submissions ?? [],
        proposal_sections: p.proposal_sections ?? [],
      });
    }
  }

  return new Response(buildIcs(feedEvents(rows, origin), now), {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="grantdesk-deadlines.ics"',
      "Cache-Control": "private, max-age=900",
    },
  });
}
