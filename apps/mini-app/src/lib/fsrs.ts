import { FsrsService, type FsrsCardState, type IntervalPreviewByRating, type Rating } from '@oxenfurt/shared'

// Production fuzz is on — UI just renders whatever the scheduler suggests.
const scheduler = new FsrsService()

export function previewIntervals(state: FsrsCardState, now: Date = new Date()): IntervalPreviewByRating {
  return scheduler.previewIntervals(state, now)
}

const MIN_PER_DAY = 24 * 60

/**
 * Renders an FSRS scheduled-days interval as a short Russian label fit for a
 * 4-button rating row. Days are fractional for learning-step intervals
 * (e.g. 1m = 1/1440 of a day).
 */
export function formatInterval(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '<1м'
  const minutes = Math.round(days * MIN_PER_DAY)
  if (minutes < 60) return `${minutes}м`
  if (minutes < MIN_PER_DAY) {
    const hours = Math.round(minutes / 60)
    return `${hours}ч`
  }
  const wholeDays = Math.round(days)
  if (wholeDays < 30) return `${wholeDays}д`
  if (wholeDays < 365) {
    const months = Math.round(wholeDays / 30)
    return `${months}мес`
  }
  const years = Math.round(wholeDays / 365)
  return `${years}г`
}

export type { Rating, FsrsCardState }
