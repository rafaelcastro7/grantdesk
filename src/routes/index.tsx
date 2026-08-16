import { createFileRoute } from "@tanstack/react-router";
import { PHASES, phaseProgress } from "@/lib/phases";

export const Route = createFileRoute("/")({
  component: Home,
});

/**
 * Phase 0's visible surface is deliberately a build status board, not a
 * placeholder hero. It has one job: make the state of the build legible while
 * the product surface is still being assembled, and be deleted the moment
 * Phase 1 ships a real screen.
 */
function Home() {
  const progress = phaseProgress(PHASES);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-[var(--color-accent)]">
        Build status
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">GrantDesk</h1>
      <p className="mt-3 max-w-prose leading-relaxed text-[var(--color-ink-soft)]">
        A grant desk for consultants running several client organizations. Fewer results, verified,
        with the receipts.
      </p>

      <div className="mt-10 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{progress.done}</span>
        <span className="text-[var(--color-ink-soft)]">of {progress.total} phases complete</span>
      </div>

      <ol className="mt-6 flex flex-col gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)]">
        {PHASES.map((phase) => (
          <li
            key={phase.id}
            className="flex items-baseline gap-3 bg-[var(--color-surface)] px-4 py-3"
          >
            <span className="w-6 shrink-0 font-mono text-xs text-[var(--color-ink-soft)]">
              {phase.id}
            </span>
            <span className="flex-1 text-sm">{phase.title}</span>
            <span
              className={
                phase.status === "done"
                  ? "text-xs font-medium text-[var(--color-eligible)]"
                  : "text-xs text-[var(--color-ink-soft)]"
              }
            >
              {phase.status === "done" ? "done" : "pending"}
            </span>
          </li>
        ))}
      </ol>
    </main>
  );
}
