import { describe, expect, test } from 'bun:test'
import { pickTheoryVariant, pickVariantFor, type PracticeMode } from './practiceMode'

// Any fixed ids — variant resolution only needs stability, not meaning.
// Synthetic uuids picked so the variant hash lands on both parities —
// hashStr's parity equals the sum of char codes, so the last hex digit
// is what flips a card between flip and typing in mixed mode.
const A = '11111111-1111-4111-8111-111111111111'
const B = '11111111-1111-4111-8111-111111111110'
const C = '33333333-3333-4333-8333-333333333333'
const D = '33333333-3333-4333-8333-333333333330'

describe('pickTheoryVariant', () => {
  test('recognition and listening keep theory as a flip-card', () => {
    for (const id of [A, B, C, D]) {
      expect(pickTheoryVariant('recognition', id)).toBe('recognition')
      expect(pickTheoryVariant('listening', id)).toBe('recognition')
    }
  })

  test('typed-answer modes exercise theory as typing', () => {
    for (const id of [A, B, C, D]) {
      expect(pickTheoryVariant('cloze', id)).toBe('typing')
      expect(pickTheoryVariant('translation', id)).toBe('typing')
    }
  })

  test('mixed alternates flip/typing but is stable per card id', () => {
    const first = pickTheoryVariant('mixed', A)
    expect(pickTheoryVariant('mixed', A)).toBe(first)
    const across = [A, B, C, D].map((id) => pickTheoryVariant('mixed', id))
    // With four ids both variants should show up; a single variant across
    // the pool would mean the hash degenerates.
    expect(new Set(across).size).toBe(2)
  })
})

describe('pickVariantFor (unchanged for vocab/phrase)', () => {
  test('non-mixed mode passes through', () => {
    const modes: PracticeMode[] = ['recognition', 'cloze', 'translation', 'listening']
    for (const mode of modes) {
      expect(pickVariantFor(mode, A)).toBe(mode)
    }
  })

  test('mixed never picks listening and is stable', () => {
    expect(pickVariantFor('mixed', A)).toBe(pickVariantFor('mixed', A))
    for (const id of [A, B, C, D]) {
      expect(pickVariantFor('mixed', id)).not.toBe('listening')
    }
  })
})
