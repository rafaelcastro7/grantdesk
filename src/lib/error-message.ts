/**
 * Get something a person can act on out of an unknown throw.
 *
 * `String(caught)` renders "[object Object]" for anything that is not an Error,
 * and Supabase rejects with a plain object — so the screen showed
 * "[object Object]" while the server had said, precisely, that a NOT NULL
 * constraint had been violated. An error the user cannot read is the same as
 * no error at all.
 */
export function errorMessage(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (typeof caught === "string") return caught;

  if (caught && typeof caught === "object") {
    const shape = caught as { message?: unknown; error_description?: unknown; details?: unknown };
    for (const candidate of [shape.message, shape.error_description, shape.details]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    // Last resort: serialize rather than surrender to "[object Object]".
    try {
      return JSON.stringify(caught);
    } catch {
      /* fall through */
    }
  }

  return "Something went wrong, and the cause was not reported.";
}
