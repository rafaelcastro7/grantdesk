import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calendarFeedResponse } from "./calendar-feed";
import { generateCalendarToken, hashCalendarToken } from "@/lib/calendar-feed";

type Filter = { op: string; column: string; value: unknown };

/** Applies eq/in/is filters to in-memory tables, and records every query. */
function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const queries: Array<{ table: string; filters: Filter[] }> = [];
  const client = {
    from(table: string) {
      const filters: Filter[] = [];
      queries.push({ table, filters });
      const run = () => {
        const rows = (tables[table] ?? []).filter((row) =>
          filters.every((f) =>
            f.op === "eq"
              ? row[f.column] === f.value
              : f.op === "in"
                ? (f.value as unknown[]).includes(row[f.column])
                : row[f.column] === f.value,
          ),
        );
        return { data: rows, error: null };
      };
      const q = {
        select: () => q,
        eq: (column: string, value: unknown) => (filters.push({ op: "eq", column, value }), q),
        in: (column: string, value: unknown) => (filters.push({ op: "in", column, value }), q),
        is: (column: string, value: unknown) => (filters.push({ op: "is", column, value }), q),
        maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve(run()),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

const proposal = (id: string, clientId: string, title: string) => ({
  id,
  client_id: clientId,
  grant_id: `g-${id}`,
  clients: { name: `Client ${clientId}` },
  grants: { title, deadline: "2026-11-01", estimated_deadline: null },
  submissions: [],
  proposal_sections: [{ id: "s" }],
});

describe("calendarFeedResponse", () => {
  it("returns 404 for a malformed or unknown token without reading proposals", async () => {
    const { client, queries } = fakeDb({ calendar_tokens: [] });
    expect((await calendarFeedResponse(client, "short", "https://x")).status).toBe(404);
    expect((await calendarFeedResponse(client, generateCalendarToken(), "https://x")).status).toBe(
      404,
    );
    expect(queries.some((q) => q.table === "proposals")).toBe(false);
  });

  it("serves only the token owner's clients inside their tenants", async () => {
    const token = generateCalendarToken();
    const { client } = fakeDb({
      calendar_tokens: [
        { token_hash: await hashCalendarToken(token), consultant_id: "me", revoked_at: null },
      ],
      tenant_members: [{ user_id: "me", tenant_id: "t1" }],
      clients: [
        { id: "mine", consultant_id: "me", tenant_id: "t1" },
        { id: "team", consultant_id: "other", tenant_id: "t1" },
        { id: "elsewhere", consultant_id: "me", tenant_id: "t2" },
        { id: "theirs", consultant_id: "other", tenant_id: "t1" },
      ],
      client_team_members: [{ user_id: "me", client_id: "team" }],
      proposals: [
        proposal("p1", "mine", "Mine Fund"),
        proposal("p2", "team", "Team Fund"),
        proposal("p3", "elsewhere", "Other Tenant Fund"),
        proposal("p4", "theirs", "Their Fund"),
      ],
      opportunity_decisions: [],
    });

    const response = await calendarFeedResponse(client, token, "https://x");
    const body = await response.text();

    expect(response.headers.get("content-type")).toMatch(/^text\/calendar/);
    expect(body).toContain("Mine Fund");
    expect(body).toContain("Team Fund");
    expect(body).not.toContain("Other Tenant Fund");
    expect(body).not.toContain("Their Fund");
  });
});
