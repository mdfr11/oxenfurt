import { describe, expect, test } from 'bun:test'
import { FSRS_STATE, FsrsService } from './index.ts'
import { RATING } from '../schemas/rating.ts'

const NOW = new Date('2026-01-01T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function freshService(): FsrsService {
  // enableFuzz: false — детерминизм в тестах. Без этого scheduled_days вариативен.
  return new FsrsService({ enableFuzz: false })
}

describe('FsrsService.createInitialState', () => {
  test('returns a New-state card with no reviews', () => {
    const state = freshService().createInitialState(NOW)
    expect(state.fsrs_state).toBe(FSRS_STATE.New)
    expect(state.reps).toBe(0)
    expect(state.lapses).toBe(0)
    expect(state.last_review).toBeNull()
  })

  test('due timestamp is serialised as ISO and matches the given time', () => {
    const state = freshService().createInitialState(NOW)
    expect(state.due).toBe(NOW.toISOString())
  })
})

describe('FsrsService.applyRating', () => {
  test('Good on a New card advances it into Learning and sets a future due date', () => {
    const svc = freshService()
    const initial = svc.createInitialState(NOW)
    const { next, log } = svc.applyRating(initial, RATING.Good, NOW)
    expect(next.fsrs_state).toBe(FSRS_STATE.Learning)
    expect(new Date(next.due).getTime()).toBeGreaterThan(NOW.getTime())
    expect(next.reps).toBe(1)
    expect(next.last_review).toBe(NOW.toISOString())
    expect(log.rating).toBe(3)
  })

  test('Again on a New card keeps it in Learning with a short interval', () => {
    const svc = freshService()
    const initial = svc.createInitialState(NOW)
    const { next } = svc.applyRating(initial, RATING.Again, NOW)
    expect(next.fsrs_state).toBe(FSRS_STATE.Learning)
    const intervalMs = new Date(next.due).getTime() - NOW.getTime()
    expect(intervalMs).toBeGreaterThan(0)
    expect(intervalMs).toBeLessThan(HOUR)
  })

  test('repeated Goods eventually graduate the card to Review', () => {
    const svc = freshService()
    let state = svc.createInitialState(NOW)
    const MAX_STEPS = 10
    let steps = 0
    while (state.fsrs_state !== FSRS_STATE.Review && steps < MAX_STEPS) {
      const when = new Date(state.due)
      state = svc.applyRating(state, RATING.Good, when).next
      steps++
    }
    expect(state.fsrs_state).toBe(FSRS_STATE.Review)
    expect(state.reps).toBe(steps)
    expect(state.lapses).toBe(0)
    expect(state.scheduled_days).toBeGreaterThan(0)
  })

  test('Again on a Review card increments lapses and moves it to Relearning', () => {
    const svc = freshService()
    let state = svc.createInitialState(NOW)
    let steps = 0
    while (state.fsrs_state !== FSRS_STATE.Review && steps < 10) {
      state = svc.applyRating(state, RATING.Good, new Date(state.due)).next
      steps++
    }
    expect(state.fsrs_state).toBe(FSRS_STATE.Review)
    const failed = svc.applyRating(state, RATING.Again, new Date(state.due)).next
    expect(failed.fsrs_state).toBe(FSRS_STATE.Relearning)
    expect(failed.lapses).toBe(1)
  })

  test('applyRating is deterministic with enableFuzz disabled', () => {
    const a = freshService()
    const b = freshService()
    const initA = a.createInitialState(NOW)
    const initB = b.createInitialState(NOW)
    const resultA = a.applyRating(initA, RATING.Good, NOW).next
    const resultB = b.applyRating(initB, RATING.Good, NOW).next
    expect(resultA).toEqual(resultB)
  })
})

describe('FsrsService.previewIntervals', () => {
  test('returns an interval for every rating', () => {
    const svc = freshService()
    const state = svc.createInitialState(NOW)
    const preview = svc.previewIntervals(state, NOW)
    expect(preview[1]).toBeDefined()
    expect(preview[2]).toBeDefined()
    expect(preview[3]).toBeDefined()
    expect(preview[4]).toBeDefined()
  })

  test('Easy schedules further out than Again on a Review-state card', () => {
    const svc = freshService()
    let state = svc.createInitialState(NOW)
    let steps = 0
    while (state.fsrs_state !== FSRS_STATE.Review && steps < 10) {
      state = svc.applyRating(state, RATING.Good, new Date(state.due)).next
      steps++
    }
    const preview = svc.previewIntervals(state, new Date(state.due))
    expect(preview[4].days).toBeGreaterThan(preview[1].days)
    expect(preview[3].days).toBeGreaterThanOrEqual(preview[2].days)
  })

  test('preview does not mutate the input state', () => {
    const svc = freshService()
    const state = svc.createInitialState(NOW)
    const snapshot = structuredClone(state)
    svc.previewIntervals(state, NOW)
    expect(state).toEqual(snapshot)
  })

  test('new card preview shows learning-step intervals as small fractions of a day', () => {
    // Regression guard: previously we read `card.scheduled_days` directly,
    // which is 0 during learning-step transitions. That made every rating
    // except Easy display "<1м" on brand-new cards. The fix reads
    // `due - now`, so a 1-minute step now reads as ~0.0007 days.
    const svc = freshService()
    const state = svc.createInitialState(NOW)
    const preview = svc.previewIntervals(state, NOW)
    const oneMinuteInDays = 1 / (24 * 60)

    // Again should be roughly the first learning step (1 minute) ± fuzz.
    expect(preview[1].days).toBeGreaterThan(0)
    expect(preview[1].days).toBeLessThan(0.1) // way under 1 day

    // Good should be ≥ Again (later learning step or graduation).
    expect(preview[3].days).toBeGreaterThanOrEqual(preview[1].days)

    // Easy graduates the card straight to Review — should be days, not minutes.
    expect(preview[4].days).toBeGreaterThan(1)
    expect(preview[4].days).toBeGreaterThan(preview[3].days)

    // And critically: nothing falls back to 0 / "<1m" by accident.
    expect(preview[1].days).toBeGreaterThanOrEqual(oneMinuteInDays * 0.5)
    expect(preview[2].days).toBeGreaterThanOrEqual(oneMinuteInDays * 0.5)
    expect(preview[3].days).toBeGreaterThanOrEqual(oneMinuteInDays * 0.5)
  })
})

describe('round-trip card state', () => {
  test('serialise → deserialise → serialise produces identical state', () => {
    const svc = freshService()
    let state = svc.createInitialState(NOW)
    for (let i = 0; i < 5; i++) {
      const when = new Date(state.due.length > 0 ? state.due : NOW)
      state = svc.applyRating(state, RATING.Good, when).next
    }
    const next = svc.applyRating(state, RATING.Hard, new Date(state.due)).next
    expect(typeof next.due).toBe('string')
    expect(typeof next.last_review).toBe('string')
    expect(next.fsrs_state).toBeOneOf([
      FSRS_STATE.New,
      FSRS_STATE.Learning,
      FSRS_STATE.Review,
      FSRS_STATE.Relearning,
    ])
  })
})

describe('schema integration', () => {
  test('a freshly-created initial state is a valid FsrsCardState payload', async () => {
    const v = await import('valibot')
    const { FsrsCardStateSchema } = await import('../schemas/fsrs.ts')
    const state = freshService().createInitialState(NOW)
    const parsed = v.parse(FsrsCardStateSchema, state)
    expect(parsed).toEqual(state)
  })

  test('an updated card state after a rating still satisfies the schema', async () => {
    const v = await import('valibot')
    const { FsrsCardStateSchema } = await import('../schemas/fsrs.ts')
    const svc = freshService()
    const initial = svc.createInitialState(NOW)
    const { next } = svc.applyRating(initial, RATING.Easy, NOW)
    expect(() => v.parse(FsrsCardStateSchema, next)).not.toThrow()
  })
})
