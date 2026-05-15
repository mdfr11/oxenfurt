/**
 * Lightweight string-distance utilities used by the cloze-deletion practice
 * mode. Lets the UI tell the user "you got it" / "close enough" / "miss"
 * without making the user's rating choice for them.
 *
 * Match classification thresholds were chosen empirically for English vocab
 * of 1..30 chars — long phrases benefit from a more forgiving bound, so the
 * `close` band scales with the expected length.
 */

export type MatchKind = 'exact' | 'close' | 'miss'

export interface MatchResult {
  kind: MatchKind
  distance: number
  /** The threshold up to which a `close` match is allowed. Useful for tests. */
  closeThreshold: number
}

/**
 * Iterative Wagner–Fischer with a single-row buffer — O(m·n) time, O(min(m,n))
 * space. Cheap enough for the lengths we care about (≤ ~100 chars).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Iterate the shorter string in the inner loop for smaller buffer.
  const [s1, s2] = a.length < b.length ? [a, b] : [b, a]
  const n = s2.length
  const prev = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j

  for (let i = 1; i <= s1.length; i++) {
    let prevDiag = prev[0]!
    prev[0] = i
    for (let j = 1; j <= n; j++) {
      const cur = prev[j]!
      if (s1.charCodeAt(i - 1) === s2.charCodeAt(j - 1)) {
        prev[j] = prevDiag
      } else {
        prev[j] = 1 + Math.min(prev[j - 1]!, cur, prevDiag)
      }
      prevDiag = cur
    }
  }
  return prev[n]!
}

function normaliseInput(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Compares the user's typed answer against the expected term and returns
 * the classification. Empty answers always count as a miss regardless of
 * `expected`.
 */
export function matchAnswer(input: string, expected: string): MatchResult {
  const a = normaliseInput(input)
  const b = normaliseInput(expected)

  if (a.length === 0) {
    return { kind: 'miss', distance: b.length, closeThreshold: closeThresholdFor(b) }
  }

  const distance = levenshtein(a, b)
  const closeThreshold = closeThresholdFor(b)

  if (distance === 0) return { kind: 'exact', distance, closeThreshold }
  if (distance <= closeThreshold) return { kind: 'close', distance, closeThreshold }
  return { kind: 'miss', distance, closeThreshold }
}

/**
 * `close` band: 1 char for short words, scaled gently for longer phrases.
 * Examples:
 *   "of"          → 1  (single-edit slack)
 *   "pragmatic"   → 1
 *   "get rid of"  → 2
 *   "to latch onto" → 2
 *   "looking forward to seeing you" → 3
 */
function closeThresholdFor(expected: string): number {
  const len = expected.length
  if (len <= 5) return 1
  if (len <= 12) return 1
  if (len <= 20) return 2
  return 3
}
