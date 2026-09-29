/// <reference types="vite/client" />
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import styles from "../styles.css?url";
import { Nav } from "@/components/Nav";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "IIAL Grant Desk" },
    ],
    links: [
      { rel: "stylesheet", href: styles },
      // Montserrat and Roboto, as iial.ca uses them. Preconnected because a
      // heading that arrives in the fallback face and then reflows is the
      // first thing a visitor sees.
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700&family=Roboto:wght@400;500&display=swap",
      },
      { rel: "icon", href: "/brand/iial-logo.png" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Nav />
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  // Make hydration observable. Server-rendered markup is fully visible and
  // clickable before React attaches its handlers, so a click that arrives in
  // that window is silently a no-op — the button looks pressed and nothing
  // happens. Tests (and anyone debugging "the button does nothing") need a
  // signal for when the page is actually interactive, and guessing with a
  // sleep is how flaky suites are born.
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
