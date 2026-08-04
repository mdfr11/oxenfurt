// Pure helpers for the assignment flow, kept out of the React tree so the
// two decisions that are easy to get wrong — queue composition and the
// drill flag — are unit-testable. Same rationale as practiceHelpers.ts.

import type { AssignmentItemDto, DueCardDto } from '@oxenfurt/shared';

/** Cards still owed, in the order the agent laid them out. Completed items
 *  never re-enter the queue — the assignment is a to-do list, not a deck. */
export function buildAssignmentQueue(items: AssignmentItemDto[]): DueCardDto[] {
  return [...items]
    .filter((item) => item.completed_at === null)
    .sort((a, b) => a.position - b.position)
    .map((item) => item.card);
}

/**
 * True when this answer is a repeat rather than a measurement.
 *
 * The first answer per card per day is the honest FSRS signal; everything
 * after it in the same day is cramming and must not be written to the
 * scheduler. Two sources say "already measured today": the in-session set of
 * cards the user has answered, and `last_review` landing on today's local
 * date (the user closed the app and came back).
 */
export function isDrillRepeat(
  card: DueCardDto,
  answeredThisSession: ReadonlySet<string>,
  now: Date,
): boolean {
  if (answeredThisSession.has(card.id)) return true;
  const last = card.fsrs.last_review;
  if (last === null) return false;
  return isSameLocalDay(new Date(last), now);
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Whole days left before the deadline, and whether we're inside the final
 *  day. `urgent` is the ONLY escalation the UI is allowed — no red, no
 *  counters, no nagging. */
export function deadlineState(dueAt: string, now: Date): { days: number; urgent: boolean } {
  const ms = new Date(dueAt).getTime() - now.getTime();
  const days = Math.max(0, Math.floor(ms / 86_400_000));
  return { days, urgent: days === 0 };
}
