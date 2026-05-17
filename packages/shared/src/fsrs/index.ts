import { createEmptyCard, fsrs, generatorParameters, Rating as FsrsRating, type Card, type FSRS, type Grade, type ReviewLog } from 'ts-fsrs'
import type { FsrsCardState } from '../schemas/fsrs.ts'
import { FSRS_STATE } from '../schemas/fsrs.ts'
import type { Rating } from '../schemas/rating.ts'

export interface FsrsConfig {
  /** Enable interval fuzzing in production. Disable in tests for determinism. */
  enableFuzz?: boolean
}

export interface ReviewResult {
  next: FsrsCardState
  log: ReviewLog
}

export interface IntervalPreview {
  /** Scheduled interval in days (may be fractional for learning steps). */
  days: number
  /** State the card would transition to. */
  next_state: FsrsCardState['fsrs_state']
}

export type IntervalPreviewByRating = Record<Rating, IntervalPreview>

const RATING_TO_FSRS: Record<Rating, Grade> = {
  1: FsrsRating.Again,
  2: FsrsRating.Hard,
  3: FsrsRating.Good,
  4: FsrsRating.Easy,
}

export class FsrsService {
  private readonly scheduler: FSRS

  constructor(config: FsrsConfig = {}) {
    const params = generatorParameters({
      enable_fuzz: config.enableFuzz ?? true,
    })
    this.scheduler = fsrs(params)
  }

  createInitialState(now: Date = new Date()): FsrsCardState {
    return toCardState(createEmptyCard(now))
  }

  applyRating(state: FsrsCardState, rating: Rating, now: Date): ReviewResult {
    const card = fromCardState(state)
    const { card: nextCard, log } = this.scheduler.next(card, now, RATING_TO_FSRS[rating])
    return { next: toCardState(nextCard), log }
  }

  previewIntervals(state: FsrsCardState, now: Date): IntervalPreviewByRating {
    const card = fromCardState(state)
    const options = this.scheduler.repeat(card, now)
    return {
      1: extractPreview(options[FsrsRating.Again].card, now),
      2: extractPreview(options[FsrsRating.Hard].card, now),
      3: extractPreview(options[FsrsRating.Good].card, now),
      4: extractPreview(options[FsrsRating.Easy].card, now),
    }
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Time-until-due in fractional days. We derive this from `due - now` rather
 * than `card.scheduled_days` because ts-fsrs leaves `scheduled_days = 0`
 * during learning-step transitions — the actual short interval lives in
 * `due` (e.g. `due = now + 1m`). Reading `scheduled_days` blindly would
 * make a brand-new card show "<1м" under every rating except Easy, which
 * defeats the whole point of showing intervals.
 */
function extractPreview(card: Card, now: Date): IntervalPreview {
  const days = Math.max(0, (card.due.getTime() - now.getTime()) / MS_PER_DAY)
  return {
    days,
    next_state: card.state as FsrsCardState['fsrs_state'],
  }
}

export function toCardState(card: Card): FsrsCardState {
  return {
    fsrs_state: card.state as FsrsCardState['fsrs_state'],
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps ?? 0,
    reps: card.reps,
    lapses: card.lapses,
    last_review: card.last_review ? card.last_review.toISOString() : null,
  }
}

export function fromCardState(state: FsrsCardState): Card {
  const card: Card = {
    due: new Date(state.due),
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: state.elapsed_days,
    scheduled_days: state.scheduled_days,
    learning_steps: state.learning_steps,
    reps: state.reps,
    lapses: state.lapses,
    state: state.fsrs_state,
  }
  if (state.last_review !== null) {
    card.last_review = new Date(state.last_review)
  }
  return card
}

export { FSRS_STATE }
