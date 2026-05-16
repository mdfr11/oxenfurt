import { describe, expect, test } from 'bun:test'
import * as v from 'valibot'
import {
  CardTypeSchema,
  CardUpdateInputSchema,
  PhrasePayloadSchema,
  PhraseUpdateInputSchema,
  TheoryPayloadSchema,
  VocabPayloadSchema,
} from './card.ts'

// These tests pin down the wire-level shape of cards. They protect against
// accidental schema regressions when fields are added/removed/renamed —
// the backend, mini-app, and Hermes all consume these types and a silent
// shape change breaks one of them in a way that's painful to debug.

describe('CardTypeSchema', () => {
  test('accepts the three known types', () => {
    for (const t of ['vocab', 'theory', 'phrase']) {
      expect(v.safeParse(CardTypeSchema, t).success).toBe(true)
    }
  })

  test('rejects unknown types', () => {
    for (const t of ['flashcard', '', 'VOCAB', null, undefined]) {
      expect(v.safeParse(CardTypeSchema, t).success).toBe(false)
    }
  })
})

describe('VocabPayloadSchema', () => {
  const valid = {
    term: 'pragmatic',
    translation: 'прагматичный',
    context_sentence: 'A pragmatic choice.',
    context_term_start: 2,
    context_term_end: 11,
  }

  test('accepts a well-formed payload', () => {
    expect(v.safeParse(VocabPayloadSchema, valid).success).toBe(true)
  })

  test('trims leading/trailing whitespace on strings', () => {
    const parsed = v.parse(VocabPayloadSchema, { ...valid, term: '  pragmatic  ' })
    expect(parsed.term).toBe('pragmatic')
  })

  test('rejects empty term', () => {
    expect(v.safeParse(VocabPayloadSchema, { ...valid, term: '' }).success).toBe(false)
  })

  test('rejects negative offsets', () => {
    expect(v.safeParse(VocabPayloadSchema, { ...valid, context_term_start: -1 }).success).toBe(false)
  })

  test('rejects non-integer offsets', () => {
    expect(v.safeParse(VocabPayloadSchema, { ...valid, context_term_start: 2.5 }).success).toBe(false)
  })

  test('rejects oversized term (>200 chars)', () => {
    expect(v.safeParse(VocabPayloadSchema, { ...valid, term: 'a'.repeat(201) }).success).toBe(false)
  })
})

describe('TheoryPayloadSchema', () => {
  test('accepts well-formed question and answer', () => {
    const out = v.safeParse(TheoryPayloadSchema, { question: 'Q?', answer: 'A.' })
    expect(out.success).toBe(true)
  })

  test('rejects empty answer', () => {
    expect(v.safeParse(TheoryPayloadSchema, { question: 'Q?', answer: '' }).success).toBe(false)
  })

  test('rejects oversized answer (>2000 chars)', () => {
    expect(
      v.safeParse(TheoryPayloadSchema, { question: 'Q?', answer: 'x'.repeat(2001) }).success,
    ).toBe(false)
  })
})

describe('PhrasePayloadSchema', () => {
  const valid = {
    phrase: 'take into account',
    translation: 'учитывать',
    context_sentence: "We'll take that into account.",
  }

  test('accepts a well-formed phrase payload', () => {
    expect(v.safeParse(PhrasePayloadSchema, valid).success).toBe(true)
  })

  test('accepts an optional pattern field', () => {
    const parsed = v.parse(PhrasePayloadSchema, {
      ...valid,
      pattern: 'to take {sth} into account',
    })
    expect(parsed.pattern).toBe('to take {sth} into account')
  })

  test('omits pattern when not provided', () => {
    const parsed = v.parse(PhrasePayloadSchema, valid)
    expect(parsed.pattern).toBeUndefined()
  })

  test('rejects phrase shorter than 2 chars', () => {
    expect(v.safeParse(PhrasePayloadSchema, { ...valid, phrase: 'a' }).success).toBe(false)
  })

  test('rejects oversized phrase (>300 chars)', () => {
    expect(
      v.safeParse(PhrasePayloadSchema, { ...valid, phrase: 'word '.repeat(70) }).success,
    ).toBe(false)
  })

  test('trims whitespace on the phrase field', () => {
    const parsed = v.parse(PhrasePayloadSchema, { ...valid, phrase: '  take into account  ' })
    expect(parsed.phrase).toBe('take into account')
  })

  test('accepts non-ASCII translations', () => {
    expect(
      v.safeParse(PhrasePayloadSchema, { ...valid, translation: 'учитывать что-то' }).success,
    ).toBe(true)
  })

  // Documents the absence of a multi-word check: there was briefly a regex
  // requiring whitespace, but it was rolled back — the only constraint now
  // is length, leaving type classification entirely to the ingest source.
  test('does NOT enforce multi-word — a single word is structurally valid', () => {
    expect(v.safeParse(PhrasePayloadSchema, { ...valid, phrase: 'sidewalk' }).success).toBe(true)
  })
})

describe('CardUpdateInputSchema (variant)', () => {
  test('accepts a vocab update payload', () => {
    const out = v.safeParse(CardUpdateInputSchema, {
      type: 'vocab',
      payload: {
        term: 'wreath',
        translation: 'венок',
        context_sentence: 'Hang the wreath on the door.',
      },
    })
    expect(out.success).toBe(true)
  })

  test('vocab update does NOT require offsets (server recomputes them)', () => {
    const out = v.safeParse(CardUpdateInputSchema, {
      type: 'vocab',
      payload: {
        term: 'wreath',
        translation: 'венок',
        context_sentence: 'Hang the wreath on the door.',
        // intentionally no context_term_start/end
      },
    })
    expect(out.success).toBe(true)
  })

  test('accepts a theory update payload', () => {
    const out = v.safeParse(CardUpdateInputSchema, {
      type: 'theory',
      payload: { question: 'Q?', answer: 'A.' },
    })
    expect(out.success).toBe(true)
  })

  test('accepts a phrase update payload, pattern optional', () => {
    const out = v.safeParse(CardUpdateInputSchema, {
      type: 'phrase',
      payload: {
        phrase: 'on the go',
        translation: 'на ходу',
        context_sentence: 'She eats on the go every morning.',
      },
    })
    expect(out.success).toBe(true)
  })

  test('rejects an unknown type', () => {
    const out = v.safeParse(CardUpdateInputSchema, {
      type: 'flashcard',
      payload: { foo: 'bar' },
    })
    expect(out.success).toBe(false)
  })

  test('rejects vocab payload sent under type=theory', () => {
    const out = v.safeParse(CardUpdateInputSchema, {
      type: 'theory',
      payload: {
        term: 'wreath',
        translation: 'венок',
        context_sentence: 'x',
      },
    })
    expect(out.success).toBe(false)
  })
})

describe('PhraseUpdateInputSchema parity with PhrasePayloadSchema', () => {
  // Update + insert payloads should accept the same shape so the client
  // doesn't have to know which one a backend handler will use.
  test('accepts the same payload as PhrasePayloadSchema', () => {
    const payload = {
      phrase: 'pay attention',
      translation: 'обращать внимание',
      context_sentence: 'Pay attention please.',
      pattern: 'to pay attention to {sth}',
    }
    expect(v.safeParse(PhraseUpdateInputSchema, payload).success).toBe(true)
    expect(v.safeParse(PhrasePayloadSchema, payload).success).toBe(true)
  })
})
