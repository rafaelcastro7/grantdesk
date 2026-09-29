/// <reference types="vite/client" />
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import styles from "../styles.css?url";
import { Nav } from "@/components/Nav";
import { I18nProvider, useI18n } from "@/lib/i18n";
import { loadLanguagePreference, saveLanguagePreference } from "@/lib/language-preference";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "GrantDesk" },
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
    <I18nProvider loadPreference={loadLanguagePreference} persist={saveLanguagePreference}>
      <RootShell />
    </I18nProvider>
  );
}

function RootShell() {
  const { t } = useI18n();
  return (
    <RootDocument>
      {/* First focusable element: skips the navigation (WCAG 2.4.1). */}
      <a href="#main" className="skip-link">
        {t("shell.skip")}
      </a>
      <Nav />
      <div id="main" tabIndex={-1} className="outline-none">
        <Outlet />
      </div>
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
  const { language } = useI18n();

  return (
    <html lang={language}>
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
