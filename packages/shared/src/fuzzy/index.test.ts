import { describe, expect, test } from 'bun:test'
import { levenshtein, matchAnswer } from './index.ts'

describe('levenshtein', () => {
  test('returns 0 for identical strings', () => {
    expect(levenshtein('', '')).toBe(0)
    expect(levenshtein('cat', 'cat')).toBe(0)
  })

  test('handles single-character edits', () => {
    expect(levenshtein('cat', 'bat')).toBe(1)
    expect(levenshtein('cat', 'cats')).toBe(1)
    expect(levenshtein('cats', 'cat')).toBe(1)
  })

  test('classic examples', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('sunday', 'saturday')).toBe(3)
  })

  test('empty string distance is length of the other', () => {
    expect(levenshtein('', 'hello')).toBe(5)
    expect(levenshtein('hello', '')).toBe(5)
  })
})

describe('matchAnswer', () => {
  test('exact match — punctuation/case agnostic', () => {
    expect(matchAnswer('pragmatic', 'pragmatic').kind).toBe('exact')
    expect(matchAnswer('Pragmatic', 'pragmatic').kind).toBe('exact')
    expect(matchAnswer('  pragmatic ', 'pragmatic').kind).toBe('exact')
    expect(matchAnswer('get  rid  of', 'get rid of').kind).toBe('exact')
  })

  test('1-character typo is "close" for short and medium words', () => {
    expect(matchAnswer('pragmtic', 'pragmatic').kind).toBe('close')
    expect(matchAnswer('cat', 'bat').kind).toBe('close')
    expect(matchAnswer('versatil', 'versatile').kind).toBe('close')
  })

  test('2-char typo on a medium-length phrase is "close"', () => {
    const r = matchAnswer('to lath onta', 'to latch onto')
    expect(r.kind).toBe('close')
  })

  test('totally different word is "miss"', () => {
    expect(matchAnswer('horse', 'pragmatic').kind).toBe('miss')
    expect(matchAnswer('xxxxx', 'cat').kind).toBe('miss')
  })

  test('empty input is always a miss', () => {
    expect(matchAnswer('', 'cat').kind).toBe('miss')
    expect(matchAnswer('   ', 'cat').kind).toBe('miss')
  })

  test('reports the distance and threshold', () => {
    const r = matchAnswer('pragmtic', 'pragmatic')
    expect(r.distance).toBe(1)
    expect(r.closeThreshold).toBeGreaterThanOrEqual(1)
  })

  test('longer phrase has a more forgiving close band', () => {
    const r = matchAnswer('looking forwrd to seeng yu', 'looking forward to seeing you')
    // 3 edits across a 29-char phrase — still considered close.
    expect(r.kind).toBe('close')
  })

  test('big distance on a short word still misses', () => {
    // "of" has threshold 1; 2 edits → miss
    expect(matchAnswer('to', 'of').kind).toBe('miss')
  })
})
