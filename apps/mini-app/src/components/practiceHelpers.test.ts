import { describe, expect, test } from 'bun:test'
import type { DueCardDto, VocabPayload } from '@oxenfurt/shared'
import {
  buildClozeSentence,
  buildPhraseCloze,
  extractClozeTerm,
  fingerprintCards,
  shouldReseed,
} from './practiceHelpers'

function vocab(over: Partial<VocabPayload> = {}): VocabPayload {
  return {
    term: 'versatile',
    translation: 'разносторонний',
    context_sentence: 'She is a versatile musician.',
    context_term_start: 9,
    context_term_end: 18,
    ...over,
  }
}

function dueCard(id: string): DueCardDto {
  // The shape of DueCardDto only matters for its `id` field in these
  // helpers; the rest is filled with placeholders to satisfy the type.
  return {
    id,
    type: 'vocab',
    payload: vocab(),
    source: null,
    source_quote: null,
    fsrs: {
      fsrs_state: 0,
      due: '2026-01-01T00:00:00.000Z',
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      learning_steps: 0,
      reps: 0,
      lapses: 0,
      last_review: null,
    },
  }
}

describe('extractClozeTerm', () => {
  test('returns sliced substring when offsets are valid', () => {
    expect(extractClozeTerm(vocab())).toBe('versatile')
  })

  test('falls back to .term when offsets are missing', () => {
    const v = vocab({ context_term_start: -1, context_term_end: -1 })
    expect(extractClozeTerm(v)).toBe('versatile')
  })

  test('falls back when offsets are out of bounds', () => {
    const v = vocab({ context_term_start: 100, context_term_end: 200 })
    expect(extractClozeTerm(v)).toBe('versatile')
  })

  test('falls back when end <= start', () => {
    const v = vocab({ context_term_start: 10, context_term_end: 10 })
    expect(extractClozeTerm(v)).toBe('versatile')
  })
})

describe('buildClozeSentence', () => {
  test('splits at the offsets when valid', () => {
    const result = buildClozeSentence(vocab())
    expect(result).toEqual({
      before: 'She is a ',
      after: ' musician.',
      targetLength: 9,
    })
  })

  test('falls back to "(term = ?)" pattern when offsets are unusable', () => {
    const result = buildClozeSentence(vocab({ context_term_start: -1, context_term_end: -1 }))
    expect(result.before).toBe('She is a versatile musician. (')
    expect(result.after).toBe(' = ?)')
    expect(result.targetLength).toBe('versatile'.length)
  })
})

describe('buildPhraseCloze', () => {
  test('returns null for single-word phrase', () => {
    expect(buildPhraseCloze('hello', 'card-1')).toBeNull()
  })

  test('blanks second word for a 2-word phrase', () => {
    const result = buildPhraseCloze('take care', 'card-1')!
    expect(result.before).toBe('take')
    expect(result.blank).toBe('care')
    expect(result.after).toBe('')
  })

  test('blanks an inner word for a ≥3-word phrase', () => {
    const result = buildPhraseCloze('take into account', 'card-1')!
    // Inner range is index 1 only here, so blank must be 'into'.
    expect(result.blank).toBe('into')
  })

  test('blank position is stable per card id', () => {
    const a = buildPhraseCloze('on the other hand entirely', 'card-x')!
    const b = buildPhraseCloze('on the other hand entirely', 'card-x')!
    expect(a.blank).toBe(b.blank)
  })

  test('blank position differs across distinct card ids (statistically)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const c = buildPhraseCloze('on the other hand entirely', `card-${i}`)!
      seen.add(c.blank)
    }
    // Inner positions are 'the', 'other', 'hand' (3 options). With 20
    // random card ids we expect at least 2 distinct picks.
    expect(seen.size).toBeGreaterThanOrEqual(2)
  })
})

describe('fingerprintCards', () => {
  test('joins ids with the | separator', () => {
    expect(fingerprintCards([dueCard('a'), dueCard('b')])).toBe('a|b')
  })

  test('returns empty string for empty list', () => {
    expect(fingerprintCards([])).toBe('')
  })

  test('same ids → same fingerprint', () => {
    expect(fingerprintCards([dueCard('a'), dueCard('b')])).toBe(
      fingerprintCards([dueCard('a'), dueCard('b')]),
    )
  })
})

describe('shouldReseed', () => {
  test('seeds the first time we receive a non-empty list (resumed=null, no prior seed)', () => {
    expect(shouldReseed(null, null, [dueCard('a')])).toBe(true)
  })

  test('does NOT seed on background refetches once already seeded', () => {
    // This is the lock/unlock bug guard: after the user rated some
    // cards, /due returns a shorter list. The fingerprint differs from
    // the original seed, but shouldReseed must say no — re-seeding here
    // would silently reset currentIndex to 0.
    expect(shouldReseed(null, 'a|b|c', [dueCard('b'), dueCard('c')])).toBe(false)
  })

  test('does NOT seed for resumed sessions (queue hydrated from localStorage)', () => {
    expect(shouldReseed({ mode: 'mixed' }, null, [dueCard('a')])).toBe(false)
  })

  test('does NOT seed when the initial /due response is empty', () => {
    expect(shouldReseed(null, null, [])).toBe(false)
  })
})
