import { useCallback, useState } from "react";
import { errorMessage } from "./error-message";

/**
 * One contract for every action a screen performs.
 *
 * The same six lines — mark busy, clear the last error, clear the last note,
 * try, catch into an error, unmark busy — were written out fifteen times across
 * the routes, nine of them in one file. Repetition is the smaller problem. The
 * larger one is that they had drifted: one handler forgot to clear the previous
 * note, so a stale "Profile saved." sat next to a fresh list of blockers; one
 * forgot to set busy at all, so its button stayed clickable while it worked.
 *
 * `run` returns the note to show, or nothing. Throwing is how an action fails —
 * which means a failed server call and a thrown exception are handled the same
 * way, rather than each caller remembering to check `ok` and branch.
 */
export type ActionState = {
  /** The key of the action currently running, or null. */
  busy: string | null;
  error: string | null;
  note: string | null;
  run: (key: string, work: () => Promise<string | void>) => Promise<void>;
  setError: (message: string | null) => void;
  setNote: (message: string | null) => void;
};

export function useAction(): ActionState {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = useCallback(async (key: string, work: () => Promise<string | void>) => {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      const message = await work();
      if (message) setNote(message);
    } catch (caught) {
      // Never `[object Object]`: Supabase rejects with a plain object rather
      // than an Error, and a consultant reading that has been told nothing.
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }, []);

  return { busy, error, note, run, setError, setNote };
}
