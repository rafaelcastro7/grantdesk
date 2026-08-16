/**
 * The delivery plan as data, so the status board cannot drift from
 * docs/PHASES.md by someone editing prose and forgetting the UI.
 *
 * A phase flips to "done" only when its gate has actually passed — see
 * docs/PHASES.md for what each gate requires.
 */

export type PhaseStatus = "done" | "pending";

export type Phase = {
  id: string;
  title: string;
  status: PhaseStatus;
};

export const PHASES: readonly Phase[] = [
  { id: "0", title: "Foundation: isolated stack, schema, client isolation", status: "done" },
  { id: "1", title: "A client profile in ten minutes", status: "done" },
  { id: "2", title: "Catalog and honest coverage", status: "done" },
  { id: "3", title: "Verified matches", status: "pending" },
  { id: "4", title: "Requirement-driven drafting", status: "pending" },
  { id: "5", title: "Submit and track", status: "pending" },
];

export function phaseProgress(phases: readonly Phase[]): {
  done: number;
  total: number;
  complete: boolean;
} {
  const done = phases.filter((p) => p.status === "done").length;
  return { done, total: phases.length, complete: done === phases.length && phases.length > 0 };
}

/**
 * The next phase to work on, or null when everything is delivered. Order is
 * significant: phases are sequential by design, because each one's gate is the
 * next one's precondition.
 */
export function nextPhase(phases: readonly Phase[]): Phase | null {
  return phases.find((p) => p.status === "pending") ?? null;
}
