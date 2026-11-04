// Pure helpers for the assignment flow, kept out of the React tree so the
// two decisions that are easy to get wrong — queue composition and the
// drill flag — are unit-testable. Same rationale as practiceHelpers.ts.

import type {
  AssignmentDto,
  AssignmentItemDto,
  DueCardDto,
  GroupKind,
} from '@oxenfurt/shared';
import type { TKey } from '../lib/i18n';

/** Cards still owed, in the order the agent laid them out. Completed items
 *  never re-enter the queue — the assignment is a to-do list, not a deck. */
export function buildAssignmentQueue(items: AssignmentItemDto[]): DueCardDto[] {
  return [...items]
    .filter((item) => item.completed_at === null)
    .sort((a, b) => a.position - b.position)
    .map((item) => item.card);
}

/**
 * Every card in an assignment, in the agent's order, regardless of
 * `completed_at`.
 *
 * A drill ("Круги") replays a finished assignment, so filtering completed
 * items would produce an empty queue exactly when the learner asks for
 * another round. Unlike `buildAssignmentQueue`, this is not a to-do list.
 */
export function buildDrillQueue(items: AssignmentItemDto[]): DueCardDto[] {
  return [...items].sort((a, b) => a.position - b.position).map((item) => item.card);
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

/** Calendar days left before the deadline, and whether it falls today (or
 *  has already passed). `urgent` is the ONLY escalation the UI is allowed —
 *  no red, no counters, no nagging.
 *
 *  Calendar days, not elapsed 24-hour blocks: a Friday 09:00 deadline read
 *  at Thursday 22:00 is 11 hours away, which floor-divides to zero and used
 *  to render «сдать сегодня» on the wrong day. What the learner means by
 *  "today" is a date on a calendar, so both ends are normalised to local
 *  midnight before subtracting. `round` rather than `floor` because a DST
 *  boundary makes a calendar day 23 or 25 hours long. */
export function deadlineState(dueAt: string, now: Date): { days: number; urgent: boolean } {
  const due = new Date(dueAt);
  const dueMidnight = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.max(0, Math.round((dueMidnight.getTime() - todayMidnight.getTime()) / 86_400_000));
  return { days, urgent: days === 0 };
}

export interface AssignmentOutcomeGroup {
  label: string;
  kind: GroupKind;
  completed: number;
  total: number;
}

/** What Summary shows after an assignment session. */
export interface AssignmentOutcome {
  /** Needed to start a replay ("Ещё круг") from Summary — the assignment is
   *  already `completed` by then and no longer fetchable as the active one. */
  assignmentId: string;
  title: string;
  completed: number;
  total: number;
  groups: AssignmentOutcomeGroup[];
}

/** What Summary shows after one drill round ("круг") of a replay. */
export interface DrillOutcome {
  assignmentId: string;
  title: string;
  round: number;
  /** Every answer in the round, repeats included. */
  total: number;
  /** Answers rated Good or Easy. */
  correct: number;
}

/** Map from group kind to its translated qualifier, shared by Summary and
 *  the history sheet so the two can't drift. */
export const GROUP_KIND_I18N_KEY: Record<GroupKind, TKey> = {
  topic: 'assignment.group_topic',
  new: 'assignment.group_new',
  weak: 'assignment.group_weak',
};

/**
 * Folds the cards taken in this sitting into the assignment snapshot the
 * queue was built from.
 *
 * Computed client-side rather than re-fetched because a finished assignment
 * is no longer the *active* one — `/assignments/active` answers `null` at
 * exactly the moment Summary needs the numbers. The snapshot plus the set of
 * cards taken is enough, and it can't race the last review's POST.
 */
export function buildAssignmentOutcome(
  assignment: AssignmentDto,
  items: AssignmentItemDto[],
  takenCardIds: ReadonlySet<string>,
): AssignmentOutcome {
  const groups: AssignmentOutcomeGroup[] = assignment.groups.map((g) => ({
    label: g.label,
    kind: g.kind,
    completed: g.completed,
    total: g.total,
  }));

  let completed = assignment.completed;
  for (const item of items) {
    // Items already completed before this sitting are counted by the
    // snapshot; counting them again would push the total past 100%.
    if (item.completed_at !== null) continue;
    if (!takenCardIds.has(item.card.id)) continue;
    completed += 1;
    const group = groups.find((g) => g.label === item.group_label);
    if (group !== undefined) group.completed += 1;
  }

  return {
    assignmentId: assignment.id,
    title: assignment.title,
    completed: Math.min(completed, assignment.total),
    total: assignment.total,
    groups,
  };
}
