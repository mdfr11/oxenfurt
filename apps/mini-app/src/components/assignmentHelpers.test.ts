import { describe, expect, test } from 'bun:test';
import { RATING, type AssignmentDto, type AssignmentItemDto, type DueCardDto } from '@oxenfurt/shared';
import {
  buildAssignmentOutcome,
  buildAssignmentQueue,
  deadlineState,
  isDrillRepeat,
  shouldRequeueAfterRating,
} from './assignmentHelpers';

const NOW = new Date('2026-08-04T12:00:00.000Z');

function card(id: string, lastReview: string | null = null): DueCardDto {
  return {
    id,
    type: 'vocab',
    payload: {
      term: id,
      translation: 'перевод',
      context_sentence: 'A sentence.',
      context_term_start: 0,
      context_term_end: 1,
    },
    source: null,
    source_quote: null,
    fsrs: {
      fsrs_state: 2,
      due: '2026-08-04T00:00:00.000Z',
      stability: 4,
      difficulty: 6,
      elapsed_days: 1,
      scheduled_days: 2,
      learning_steps: 0,
      reps: 3,
      lapses: 1,
      last_review: lastReview,
    },
  };
}

function item(id: string, position: number, completed: boolean): AssignmentItemDto {
  return {
    card: card(id),
    group_label: 'Тема',
    group_kind: 'topic',
    position,
    completed_at: completed ? '2026-08-04T09:00:00.000Z' : null,
  };
}

describe('buildAssignmentQueue', () => {
  test('keeps position order', () => {
    const queue = buildAssignmentQueue([item('c', 2, false), item('a', 0, false), item('b', 1, false)]);
    expect(queue.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  test('drops already-completed items', () => {
    const queue = buildAssignmentQueue([item('a', 0, true), item('b', 1, false)]);
    expect(queue.map((c) => c.id)).toEqual(['b']);
  });

  test('returns an empty queue when everything is done', () => {
    expect(buildAssignmentQueue([item('a', 0, true)])).toEqual([]);
  });
});

describe('isDrillRepeat', () => {
  test('false on the first answer of a card never reviewed', () => {
    expect(isDrillRepeat(card('a', null), new Set(), NOW)).toBe(false);
  });

  test('true when the card was already answered this session', () => {
    expect(isDrillRepeat(card('a', null), new Set(['a']), NOW)).toBe(true);
  });

  test('true when the card was last reviewed earlier today', () => {
    expect(isDrillRepeat(card('a', '2026-08-04T07:30:00.000Z'), new Set(), NOW)).toBe(true);
  });

  test('false when the card was last reviewed yesterday', () => {
    expect(isDrillRepeat(card('a', '2026-08-03T23:00:00.000Z'), new Set(), NOW)).toBe(false);
  });
});

describe('deadlineState', () => {
  // Local-time constructors, not Z-suffixed literals: the function compares
  // calendar days in the learner's timezone, so a UTC literal would make the
  // expected day count depend on where the suite runs.
  const local = (y: number, m: number, d: number, h: number) => new Date(y, m - 1, d, h);
  const EVENING = local(2026, 8, 4, 22);

  test('counts calendar days remaining', () => {
    expect(deadlineState(local(2026, 8, 6, 21).toISOString(), EVENING)).toEqual({
      days: 2,
      urgent: false,
    });
  });

  test('marks a deadline falling today urgent', () => {
    expect(deadlineState(local(2026, 8, 4, 23).toISOString(), EVENING)).toEqual({
      days: 0,
      urgent: true,
    });
  });

  test('tomorrow morning is one day away, not today', () => {
    // The bug this replaces: 11 h away floor-divided to 0 whole days, so a
    // Friday-morning deadline read on Thursday evening said «сдать сегодня».
    expect(deadlineState(local(2026, 8, 5, 9).toISOString(), EVENING)).toEqual({
      days: 1,
      urgent: false,
    });
  });

  test('a deadline more than 24 h away can still be today', () => {
    // Symmetric case: 23:00 tonight read at 00:30 this morning is under a
    // day, but 23:00 *tonight* read at 00:30 today is the same calendar day.
    expect(deadlineState(local(2026, 8, 4, 23).toISOString(), local(2026, 8, 4, 0))).toEqual({
      days: 0,
      urgent: true,
    });
  });

  test('clamps a passed deadline to zero', () => {
    expect(deadlineState(local(2026, 8, 3, 21).toISOString(), EVENING)).toEqual({
      days: 0,
      urgent: true,
    });
  });
});

describe('shouldRequeueAfterRating', () => {
  test('an assignment re-queues both Again and Hard', () => {
    expect(shouldRequeueAfterRating(RATING.Again, true, false)).toBe(true);
    expect(shouldRequeueAfterRating(RATING.Hard, true, false)).toBe(true);
  });

  test('an assignment never re-queues a taken card', () => {
    expect(shouldRequeueAfterRating(RATING.Good, true, true)).toBe(false);
    expect(shouldRequeueAfterRating(RATING.Easy, true, true)).toBe(false);
  });

  test('the in-session replay setting does not apply to assignments', () => {
    // Off in settings, still on in an assignment — the item stays owed
    // regardless of what the learner prefers for free practice.
    expect(shouldRequeueAfterRating(RATING.Again, true, false)).toBe(true);
  });

  test('free practice re-queues Again only, and only when opted in', () => {
    expect(shouldRequeueAfterRating(RATING.Again, false, true)).toBe(true);
    expect(shouldRequeueAfterRating(RATING.Hard, false, true)).toBe(false);
    expect(shouldRequeueAfterRating(RATING.Again, false, false)).toBe(false);
  });
});

function assignment(overrides: Partial<AssignmentDto> = {}): AssignmentDto {
  return {
    id: 'a1',
    title: 'Условные предложения',
    rationale: null,
    status: 'active',
    source: null,
    created_at: '2026-08-04T09:00:00.000Z',
    due_at: '2026-08-06T21:00:00.000Z',
    completed_at: null,
    completed: 1,
    total: 3,
    groups: [
      { label: 'Забытое', kind: 'weak', total: 2, completed: 1 },
      { label: 'Слова с урока', kind: 'new', total: 1, completed: 0 },
    ],
    ...overrides,
  };
}

function groupedItem(
  id: string,
  position: number,
  label: string,
  kind: 'topic' | 'new' | 'weak',
  completed: boolean,
): AssignmentItemDto {
  return {
    card: card(id),
    group_label: label,
    group_kind: kind,
    position,
    completed_at: completed ? '2026-08-04T09:00:00.000Z' : null,
  };
}

describe('buildAssignmentOutcome', () => {
  const items = [
    groupedItem('a', 0, 'Забытое', 'weak', true),
    groupedItem('b', 1, 'Забытое', 'weak', false),
    groupedItem('c', 2, 'Слова с урока', 'new', false),
  ];

  test('folds this sitting into the snapshot, per group', () => {
    const out = buildAssignmentOutcome(assignment(), items, new Set(['b', 'c']));
    expect(out).toEqual({
      title: 'Условные предложения',
      completed: 3,
      total: 3,
      groups: [
        { label: 'Забытое', kind: 'weak', total: 2, completed: 2 },
        { label: 'Слова с урока', kind: 'new', total: 1, completed: 1 },
      ],
    });
  });

  test('a partial sitting reports partial progress', () => {
    const out = buildAssignmentOutcome(assignment(), items, new Set(['b']));
    expect(out.completed).toBe(2);
    expect(out.total).toBe(3);
    expect(out.groups.map((g) => g.completed)).toEqual([2, 0]);
  });

  test('does not double-count an item completed before this sitting', () => {
    // 'a' was already stamped; taking it again in a drill repeat must not
    // push the count past the denominator.
    const out = buildAssignmentOutcome(assignment(), items, new Set(['a', 'b', 'c']));
    expect(out.completed).toBe(3);
    expect(out.groups[0]!.completed).toBe(2);
  });

  test('taking nothing leaves the snapshot untouched', () => {
    const out = buildAssignmentOutcome(assignment(), items, new Set());
    expect(out.completed).toBe(1);
    expect(out.groups.map((g) => g.completed)).toEqual([1, 0]);
  });

  test('does not mutate the snapshot groups', () => {
    const snapshot = assignment();
    buildAssignmentOutcome(snapshot, items, new Set(['b', 'c']));
    expect(snapshot.groups.map((g) => g.completed)).toEqual([1, 0]);
  });
});
