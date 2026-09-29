import { createFileRoute } from "@tanstack/react-router";

/**
 * GET /api/calendar/<token> — the feed Google Calendar or Outlook polls.
 * Not a screen: it serves text/calendar and nothing else.
 */
export const Route = createFileRoute("/api/calendar/$token")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        // Server-only modules stay out of the browser bundle this file is part of.
        const [{ catalogWriter }, { calendarFeedResponse }] = await Promise.all([
          import("@/server/caller"),
          import("@/server/calendar-feed"),
        ]);
        try {
          return await calendarFeedResponse(
            catalogWriter(),
            params.token,
            new URL(request.url).origin,
          );
        } catch (caught) {
          console.error(
            `calendar feed failed: ${caught instanceof Error ? caught.message : String(caught)}`,
          );
          return new Response("The calendar feed could not be built right now.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
      },
    },
  },
});
