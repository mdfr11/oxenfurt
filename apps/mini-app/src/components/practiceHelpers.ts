// Pure helpers extracted from PracticeSession.tsx. Kept in a separate
// module so they can be unit-tested without rendering the React tree —
// the React file is ~1800 LOC and grew hostile to per-function testing.
//
// First slice on purpose contains only side-effect-free utilities:
//   * cloze + phrase rendering math (no DOM access)
//   * queue-reseed gating (state-machine decision, no setState)
// JSX-emitting renderers stay in the component until the full split.

import type { DueCardDto, VocabPayload } from '@oxenfurt/shared'

/**
 * Returns the substring of a vocab card's context_sentence covered by
 * the `context_term_start`/`context_term_end` offsets. Falls back to
 * the bare `term` field when offsets are missing or out of bounds — the
 * ingest pipeline doesn't always populate them precisely.
 */
export function extractClozeTerm(vocab: VocabPayload): string {
  const start = vocab.context_term_start
  const end = vocab.context_term_end
  if (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end > start &&
    end <= vocab.context_sentence.length
  ) {
    return vocab.context_sentence.slice(start, end)
  }
  return vocab.term
}

/**
 * Slice a vocab card into the (before, after) pair that flanks the
 * blank, plus the target length for placeholder sizing. Returns a
 * sensible fallback when offsets are unusable — appends `(term = ?)`
 * to the sentence so the learner still has somewhere to type.
 */
export function buildClozeSentence(
  vocab: VocabPayload,
): { before: string; after: string; targetLength: number } {
  const start = vocab.context_term_start
  const end = vocab.context_term_end
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > vocab.context_sentence.length
  ) {
    return {
      before: vocab.context_sentence + ' (',
      after: ' = ?)',
      targetLength: vocab.term.length,
    }
  }
  return {
    before: vocab.context_sentence.slice(0, start),
    after: vocab.context_sentence.slice(end),
    targetLength: end - start,
  }
}

/**
 * Phrase cloze: blank one word inside the multi-word phrase. The blank
 * position is deterministic per card so the user sees the same gap
 * across retries (otherwise they'd be hitting a moving target). Skips
 * the first and last word when there are at least 3 — the middle is
 * where the "tricky" content words / prepositions live. Returns null
 * for single-word "phrases" where a cloze makes no sense.
 */
export function buildPhraseCloze(
  phrase: string,
  cardId: string,
): { before: string; blank: string; after: string } | null {
  const words = phrase.trim().split(/\s+/)
  if (words.length < 2) return null

  let blankIdx: number
  if (words.length === 2) {
    blankIdx = 1
  } else {
    // Stable per card via a cheap charCode hash; restrict to inner positions.
    let hash = 0
    for (let i = 0; i < cardId.length; i++) hash = (hash * 31 + cardId.charCodeAt(i)) | 0
    const innerSpan = words.length - 2 // 1..len-2 inclusive
    blankIdx = 1 + (Math.abs(hash) % innerSpan)
  }

  return {
    before: words.slice(0, blankIdx).join(' '),
    blank: words[blankIdx]!,
    after: words.slice(blankIdx + 1).join(' '),
  }
}

/**
 * Should PracticeSession reseed its working queue from a fresh /due
 * response? `true` only on the very first non-empty load per component
 * lifetime — once we have a queue, background refetches must NOT
 * overwrite it. By the time a refetch fires the user has rated cards,
 * those have dropped out of /due, and reseeding would silently reset
 * currentIndex to 0 (the exact lock/unlock regression we fixed).
 *
 * Pure function so it can be unit-tested without rendering the
 * component — the React effect that calls this stays trivial:
 *   if (shouldReseed(resumed, queueSeed, baseCards)) {
 *     setQueueSeed(fingerprintCards(baseCards));
 *     setQueue(baseCards);
 *   }
 */
export function shouldReseed(
  resumed: { mode: string } | null,
  queueSeed: string | null,
  baseCards: DueCardDto[],
): boolean {
  return resumed === null && queueSeed === null && baseCards.length > 0
}

/**
 * Stable fingerprint over an array of cards by id. Used as the
 * `queueSeed` state value; the actual identity check is in
 * `shouldReseed`, but this is its companion writer.
 */
export function fingerprintCards(cards: DueCardDto[]): string {
  return cards.map((c) => c.id).join('|')
}
