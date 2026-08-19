/**
 * Which sources are due to be read again.
 *
 * Pure, so the decision can be tested without waiting a week for a cadence to
 * elapse. Every adapter already declares how often it is worth re-reading; this
 * is the only thing that consults that declaration, which means a scheduler can
 * simply run every hour and let this decide whether there is anything to do.
 */

export type SourceSchedule = {
  key: string;
  cadenceHours: number;
  /** When this source last completed successfully, or null if it never has. */
  lastOkAt: Date | null;
};

export type Due = {
  key: string;
  /** Said in the operator's terms, because it ends up in a log someone skims. */
  reason: string;
};

/**
 * A source is due when a full cadence has passed since its last *successful*
 * run.
 *
 * Measured from success, not from the attempt: a source that has been failing
 * every hour has not been read, and treating its failures as reads would let a
 * broken source look like a fresh one — which is the exact dishonesty the
 * coverage page exists to prevent.
 */
export function sourcesDue(sources: readonly SourceSchedule[], now: Date): Due[] {
  const due: Due[] = [];

  for (const source of sources) {
    if (!source.lastOkAt) {
      due.push({ key: source.key, reason: "never read" });
      continue;
    }
    const elapsedHours = (now.getTime() - source.lastOkAt.getTime()) / 3_600_000;
    if (elapsedHours >= source.cadenceHours) {
      due.push({
        key: source.key,
        reason: `${Math.floor(elapsedHours)}h since last read, cadence ${source.cadenceHours}h`,
      });
    }
  }

  return due;
}

/**
 * How long until the next source becomes due, in minutes.
 *
 * Only used to say something useful when there is nothing to do — a scheduled
 * run that prints "nothing due" and stops is indistinguishable from one that is
 * silently broken, and the difference matters at 3am.
 */
export function minutesUntilNextDue(sources: readonly SourceSchedule[], now: Date): number | null {
  const waits = sources
    .filter((source) => source.lastOkAt !== null)
    .map((source) => {
      const dueAt = source.lastOkAt!.getTime() + source.cadenceHours * 3_600_000;
      return (dueAt - now.getTime()) / 60_000;
    })
    .filter((minutes) => minutes > 0);

  if (waits.length === 0) return null;
  return Math.ceil(Math.min(...waits));
}
