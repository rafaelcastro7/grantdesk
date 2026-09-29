import { useEffect } from "react";

/**
 * A title per screen (WCAG 2.4.2): with every tab reading "GrantDesk", a
 * screen-reader user — or anyone with eight tabs open — cannot tell the
 * matches for one client from the draft for another.
 */
export function useDocumentTitle(...parts: Array<string | null | undefined>): void {
  const title = [...parts.filter((p): p is string => !!p && p.trim().length > 0), "GrantDesk"].join(
    " – ",
  );
  useEffect(() => {
    document.title = title;
  }, [title]);
}
