import { FsrsService, type FsrsCardState, type IntervalPreviewByRating, type Rating } from '@oxenfurt/shared'
import { t, type TKey } from './i18n'

// Production fuzz is on — UI just renders whatever the scheduler suggests.
const scheduler = new FsrsService()

export function previewIntervals(state: FsrsCardState, now: Date = new Date()): IntervalPreviewByRating {
  return scheduler.previewIntervals(state, now)
}

const MIN_PER_DAY = 24 * 60

/**
 * Renders an FSRS scheduled-days interval as a short locale-aware label
 * fit for the 4-button rating row. Days are fractional for learning-step
 * intervals (e.g. 1m = 1/1440 of a day). Picks the largest unit that
 * keeps the number readable: minutes → hours → days → months → years.
 */
export function formatInterval(days: number): string {
  const [key, n] = pickIntervalKey(days)
  return n === null ? t(key) : t(key, { n })
}

function pickIntervalKey(days: number): [TKey, number | null] {
  if (!Number.isFinite(days) || days <= 0) return ['practice.interval_lt1m', null]
  const minutes = Math.round(days * MIN_PER_DAY)
  if (minutes < 60) return ['practice.interval_minutes', minutes]
  if (minutes < MIN_PER_DAY) return ['practice.interval_hours', Math.round(minutes / 60)]
  const wholeDays = Math.round(days)
  if (wholeDays < 30) return ['practice.interval_days', wholeDays]
  if (wholeDays < 365) return ['practice.interval_months', Math.round(wholeDays / 30)]
  return ['practice.interval_years', Math.round(wholeDays / 365)]
}

export type { Rating, FsrsCardState }
