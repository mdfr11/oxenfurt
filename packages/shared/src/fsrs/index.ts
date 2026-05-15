import { createEmptyCard, fsrs, generatorParameters, Rating as FsrsRating, type Card, type FSRS, type Grade, type ReviewLog } from 'ts-fsrs'
import type { FsrsCardState } from '../schemas/fsrs.ts'
import { FSRS_STATE } from '../schemas/fsrs.ts'
import type { Rating } from '../schemas/rating.ts'

export interface FsrsConfig {
  /** Enable interval fuzzing in production. Disable in tests for determinism. */
  enableFuzz?: boolean
  /** Target retention probability. Default 0.9. Do not change on a populated deck. */
  requestRetention?: number
  /** Cap on scheduled interval in days. Default 36500 (100 years). */
  maximumInterval?: number
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
      request_retention: config.requestRetention ?? 0.9,
      maximum_interval: config.maximumInterval ?? 36500,
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
      1: extractPreview(options[FsrsRating.Again].card),
      2: extractPreview(options[FsrsRating.Hard].card),
      3: extractPreview(options[FsrsRating.Good].card),
      4: extractPreview(options[FsrsRating.Easy].card),
    }
  }
}

function extractPreview(card: Card): IntervalPreview {
  return {
    days: card.scheduled_days,
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
