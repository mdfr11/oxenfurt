// Queue + session-stats state machine for PracticeSession. Owns the
// in-memory working queue, the current cursor, the running tally of
// total/correct, the pending-review undo slot, and the
// backend-session-id ref used by the finish API.
//
// Pulled out of PracticeSession.tsx (~1700 LOC) into its own file
// because the lock/unlock regression we fixed earlier (mid-session
// background refetch silently re-seeding the queue and resetting the
// cursor to 0) lived precisely in this state machine — having it in
// one focused module makes future regressions easier to spot and
// easier to test. The seed decision itself is a pure function
// (`shouldReseed` in practiceHelpers) so the hook can't disagree with
// the unit tests.
//
// What the hook does NOT own: the rating workflow (handleRate /
// handleUndo). That stays in the component because each rating fires
// haptic + sound + UI flip + backend mutation + completion callback —
// pulling all of it in would force the hook to import too many UI
// concerns. The hook exposes the *queue* operations the workflow needs
// (advance, splice, removeSplicedAt, rollback, finish) and the
// component composes them with its UI side effects.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { DueCardDto, Rating } from '@oxenfurt/shared'
import { fetchWithAuth } from '../lib/api'
import { clearSession, loadSession, saveSession } from '../lib/sessionPersist'
import type { PracticeMode } from '../lib/practiceMode'
import { fingerprintCards, shouldReseed } from '../components/practiceHelpers'

/** Snapshot needed to undo the last rating — restores both the queue
 *  position and the running stats. The replay-splice index is set when
 *  the user rated Again with in-session replay on, so undo can also
 *  unsplice. */
export interface PendingReview {
  id: string
  rating: Rating
  /** Whether this answer was a repeat rather than a measurement (see
   *  isDrillRepeat). Stashed here so the unmount flush posts the same
   *  flag the delayed call would have — recomputing it there would look
   *  at a card the user has since answered and get the opposite answer. */
  drill: boolean
  timeoutId: number
  previousIndex: number
  previousStats: SessionStats
  replaySpliceIndex: number | null
}

export interface SessionStats {
  total: number
  correct: number
}

export interface UsePracticeQueueArgs {
  /** Current practice mode. Resumed sessions only hydrate when this
   *  matches the persisted mode — switching modes starts fresh. */
  mode: PracticeMode
  /** Cards the /due query returned (post-type-filter). Seeded into the
   *  working queue once; never re-seeded after that. */
  baseCards: DueCardDto[]
}

export interface UsePracticeQueueResult {
  // ---- Read-only state surfaces -----------------------------------
  queue: DueCardDto[]
  currentIndex: number
  sessionStats: SessionStats
  /** Card under the cursor, or undefined while loading or after
   *  completion. */
  currentCard: DueCardDto | undefined
  /** 0..100. Computed from queue length and cursor — empty queue
   *  reads as 0. */
  progress: number
  /** When non-null, the user has 3.5 s to undo their last rating
   *  before the server call fires. */
  pendingReview: PendingReview | null
  /** True if we hydrated from a paused session in localStorage. The
   *  component uses this to skip the `/due` fetch and the seed effect. */
  resumed: boolean

  // ---- Queue / cursor mutations -----------------------------------
  /** Splice the failed card a few positions ahead of the cursor.
   *  Used by handleRate when rating === Again and in-session replay
   *  is on. Returns the splice position so the caller can stash it
   *  on PendingReview for undo. */
  spliceAhead: (card: DueCardDto, offset?: number) => number
  /** Reverse a previous splice (used by undo). */
  removeAt: (index: number) => void
  /** Advance the cursor by one and merge the rating into stats. */
  advance: (delta: { total: 1; correct: 0 | 1 }) => void
  /** Restore an earlier cursor + stats from a PendingReview snapshot. */
  rollback: (index: number, stats: SessionStats) => void
  setPendingReview: (p: PendingReview | null) => void

  // ---- Lifecycle --------------------------------------------------
  /** Marks the session done so the persist effect stops re-saving the
   *  just-cleared localStorage entry. Idempotent. */
  markFinished: () => void
  /** Calls POST /sessions/:id/finish if a backend session id exists
   *  and we haven't finished already. Fire-and-forget. */
  finishBackendSession: (total: number, correct: number) => void
  /** Wipe the working queue + cursor + stats. Used when the user
   *  flips bypass-due mode in the empty state — they're opting into a
   *  brand-new queue and shouldReseed needs to fire again. */
  resetQueue: () => void
  /** Patch a single card in the working queue (same id, new payload).
   *  Used after EditCardSheet.onSaved so the user sees the edit on
   *  the card they're currently looking at. */
  updateCard: (updated: DueCardDto) => void
}

export function usePracticeQueue({
  mode,
  baseCards,
}: UsePracticeQueueArgs): UsePracticeQueueResult {
  // One-shot snapshot of the resumed session — reading once on mount
  // is intentional. Subsequent writes go back through saveSession.
  const resumedSnapshot = useMemo(() => loadSession(mode), [mode])
  const resumed = resumedSnapshot !== null

  const [queue, setQueue] = useState<DueCardDto[]>(() => resumedSnapshot?.cards ?? [])
  const [queueSeed, setQueueSeed] = useState<string | null>(() =>
    resumedSnapshot ? fingerprintCards(resumedSnapshot.cards) : null,
  )
  const [currentIndex, setCurrentIndex] = useState(() => resumedSnapshot?.currentIndex ?? 0)
  const [sessionStats, setSessionStats] = useState<SessionStats>(
    () => resumedSnapshot?.stats ?? { total: 0, correct: 0 },
  )
  const [pendingReview, setPendingReview] = useState<PendingReview | null>(null)

  const sessionIdRef = useRef<string | null>(null)
  const sessionFinishedRef = useRef(false)

  // Boot a backend session so the finish API can stamp duration. The
  // local flow doesn't depend on the id — if the POST fails the finish
  // call simply gets skipped.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetchWithAuth('/sessions', { method: 'POST' })
        if (!res.ok) return
        const body = (await res.json()) as { id: string }
        if (!cancelled) sessionIdRef.current = body.id
      } catch {
        // Best-effort; practice still works untracked.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Seed-once on first non-empty load. The condition (`resumed===null
  // && queueSeed===null && baseCards.length>0`) is a pure function in
  // practiceHelpers so it stays unit-testable and the hook can't
  // disagree with the spec.
  if (shouldReseed(resumedSnapshot, queueSeed, baseCards)) {
    setQueueSeed(fingerprintCards(baseCards))
    setQueue(baseCards)
  }

  // Persist on every meaningful change. Three skip conditions — see
  // the previous bug report: without the finished-ref guard, the
  // post-clear setSessionStats commit would otherwise re-save the
  // just-cleared queue and Home would keep showing the paused-session
  // pill even after a clean completion.
  useEffect(() => {
    if (sessionFinishedRef.current) return
    if (queue.length === 0 || currentIndex >= queue.length) return
    saveSession({
      mode,
      cards: queue,
      currentIndex,
      stats: sessionStats,
      savedAt: Date.now(),
    })
  }, [mode, queue, currentIndex, sessionStats])

  const spliceAhead = (card: DueCardDto, offset = 4): number => {
    const pos = Math.min(currentIndex + offset, queue.length)
    setQueue((q) => {
      const insertAt = Math.min(currentIndex + offset, q.length)
      return [...q.slice(0, insertAt), card, ...q.slice(insertAt)]
    })
    return pos
  }

  const removeAt = (index: number): void => {
    setQueue((q) => [...q.slice(0, index), ...q.slice(index + 1)])
  }

  const advance = (delta: { total: 1; correct: 0 | 1 }): void => {
    setSessionStats((prev) => ({
      total: prev.total + delta.total,
      correct: prev.correct + delta.correct,
    }))
    setCurrentIndex((idx) => idx + 1)
  }

  const rollback = (index: number, stats: SessionStats): void => {
    setCurrentIndex(index)
    setSessionStats(stats)
  }

  const markFinished = (): void => {
    sessionFinishedRef.current = true
    clearSession()
  }

  const resetQueue = (): void => {
    setQueue([])
    setQueueSeed(null)
    setCurrentIndex(0)
    setSessionStats({ total: 0, correct: 0 })
    setPendingReview(null)
  }

  const updateCard = (updated: DueCardDto): void => {
    setQueue((q) => q.map((c) => (c.id === updated.id ? updated : c)))
  }

  const finishBackendSession = (total: number, correct: number): void => {
    const id = sessionIdRef.current
    if (id === null || sessionFinishedRef.current) return
    sessionFinishedRef.current = true
    void fetchWithAuth(`/sessions/${id}/finish`, {
      method: 'POST',
      body: JSON.stringify({ cards_reviewed: total, cards_correct: correct }),
    }).catch(() => {
      // Best-effort. Idempotent backend-side.
    })
  }

  const currentCard = queue[currentIndex]
  const progress = queue.length > 0 ? (currentIndex / queue.length) * 100 : 0

  return {
    queue,
    currentIndex,
    sessionStats,
    currentCard,
    progress,
    pendingReview,
    resumed,
    spliceAhead,
    removeAt,
    advance,
    rollback,
    setPendingReview,
    markFinished,
    finishBackendSession,
    resetQueue,
    updateCard,
  }
}
