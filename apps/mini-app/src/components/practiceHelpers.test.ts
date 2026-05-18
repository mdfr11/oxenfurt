import { describe, expect, test } from 'bun:test'
import type { DueCardDto, VocabPayload } from '@oxenfurt/shared'
import {
  buildClozeSentence,
  buildPhraseCloze,
  extractClozeTerm,
  fingerprintCards,
  locateTerm,
  pickSpeakable,
  shouldAutoPronounce,
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

describe('locateTerm', () => {
  test('trusts hinted offsets when they slice to the term exactly', () => {
    expect(locateTerm('She is a versatile musician.', 'versatile', 9, 18)).toEqual({
      start: 9,
      end: 18,
    })
  })

  test('falls back to substring search when the hint is off by one+', () => {
    // The real user-reported regression: sentence
    //   "I didn't hear any laughter from that company."
    // "laughter" sits at [18, 26). LLM returned hint [19, 27) — start
    // is one char past the real start, end swallows the trailing
    // space. Slice on the hint gives "aughter " which doesn't match
    // the term, so locateTerm has to search.
    const sentence = "I didn't hear any laughter from that company."
    expect(locateTerm(sentence, 'laughter', 19, 27)).toEqual({ start: 18, end: 26 })
  })

  test('handles case-insensitive matching', () => {
    expect(locateTerm('Versatile means many things.', 'versatile', -1, -1)).toEqual({
      start: 0,
      end: 9,
    })
  })

  test('prefers the occurrence closest to the hint when the term repeats', () => {
    const sentence = 'leak somewhere or another leak in the pipe.'
    // First "leak" at 0, second at 26. Hint near the second one →
    // second wins.
    expect(locateTerm(sentence, 'leak', 24, 28)).toEqual({ start: 26, end: 30 })
  })

  test('returns null when the term is not in the sentence at all', () => {
    expect(locateTerm('Completely unrelated text.', 'versatile', 0, 9)).toBeNull()
  })
})

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

  test('corrects an off-by-one hint by searching for the term', () => {
    // Hint says [10, 18) instead of [9, 18) — slice would give
    // "ersatile" instead of "versatile". Should heal.
    const v = vocab({ context_term_start: 10, context_term_end: 18 })
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

  test('falls back to "(term = ?)" pattern only when the term is genuinely missing', () => {
    // Term not in the sentence at all → fallback.
    const result = buildClozeSentence(
      vocab({ term: 'absent', context_term_start: -1, context_term_end: -1 }),
    )
    expect(result.before).toBe('She is a versatile musician. (')
    expect(result.after).toBe(' = ?)')
    expect(result.targetLength).toBe('absent'.length)
  })

  test('repairs the rendered card when the LLM hint shifts both ends', () => {
    // Real user-reported regression. Hermes returned offsets that
    // pointed one char into "laughter" and swallowed the trailing
    // space, so the cloze rendered as
    //   "I didn't hear any l______from that company."
    // with the "l" leaking outside the blank and no space before
    // "from". After the locateTerm fix the blank covers exactly
    // "laughter" with proper spacing on both sides.
    const result = buildClozeSentence({
      term: 'laughter',
      translation: 'смех',
      context_sentence: "I didn't hear any laughter from that company.",
      context_term_start: 19, // one char past the real start
      context_term_end: 27, // one char past the real end (eats the space)
    })
    expect(result.before).toBe("I didn't hear any ")
    expect(result.after).toBe(' from that company.')
    expect(result.targetLength).toBe('laughter'.length)
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

describe('pickSpeakable', () => {
  test('returns the vocab term', () => {
    expect(pickSpeakable(dueCard('a'))).toBe('versatile')
  })

  test('returns the phrase string for a phrase card', () => {
    const card: DueCardDto = {
      ...dueCard('p'),
      type: 'phrase',
      payload: { phrase: 'take into account', translation: '...', context_sentence: 'x' },
    }
    expect(pickSpeakable(card)).toBe('take into account')
  })

  test('returns null for theory cards (nothing useful to speak)', () => {
    const card: DueCardDto = {
      ...dueCard('t'),
      type: 'theory',
      payload: { question: 'Q', answer: 'A' },
    }
    expect(pickSpeakable(card)).toBeNull()
  })

  test('returns null when no card is loaded yet', () => {
    expect(pickSpeakable(undefined)).toBeNull()
  })
})

describe('shouldAutoPronounce', () => {
  const base = {
    speakable: 'versatile',
    variant: 'recognition' as const,
    autoPronounce: false,
    isRevealed: false,
    flipForProduce: false,
  }

  test('listening variant always speaks (even without autoPronounce setting)', () => {
    expect(shouldAutoPronounce({ ...base, variant: 'listening' })).toBe(true)
  })

  test('non-listening variant gates on the autoPronounce setting', () => {
    expect(shouldAutoPronounce({ ...base, autoPronounce: false })).toBe(false)
    expect(shouldAutoPronounce({ ...base, autoPronounce: true })).toBe(true)
  })

  test('silenced once the back is revealed', () => {
    expect(shouldAutoPronounce({ ...base, variant: 'listening', isRevealed: true })).toBe(false)
  })

  test('silenced when produce-mode flips the card (term is the answer)', () => {
    expect(shouldAutoPronounce({ ...base, variant: 'listening', flipForProduce: true })).toBe(false)
  })

  test('silenced when there is nothing speakable (theory cards)', () => {
    expect(shouldAutoPronounce({ ...base, variant: 'listening', speakable: null })).toBe(false)
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
