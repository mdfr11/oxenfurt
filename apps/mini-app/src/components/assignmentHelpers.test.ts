import { describe, expect, test } from 'bun:test';
import type { AssignmentItemDto, DueCardDto } from '@oxenfurt/shared';
import { buildAssignmentQueue, deadlineState, isDrillRepeat } from './assignmentHelpers';

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
  test('counts whole days remaining', () => {
    expect(deadlineState('2026-08-06T21:00:00.000Z', NOW)).toEqual({ days: 2, urgent: false });
  });

  test('marks the final day urgent', () => {
    expect(deadlineState('2026-08-04T21:00:00.000Z', NOW)).toEqual({ days: 0, urgent: true });
  });

  test('clamps a passed deadline to zero', () => {
    expect(deadlineState('2026-08-03T21:00:00.000Z', NOW)).toEqual({ days: 0, urgent: true });
  });
});
