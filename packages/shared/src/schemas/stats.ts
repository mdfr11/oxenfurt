// Stats DTOs returned by GET /sessions/stats. Single round-trip — backend
// produces it all at once because the mini-app is mobile-bound and we'd
// rather not fan out N requests on the Stats screen.

export interface ReviewWindow {
  /** Total reviews submitted in the window. */
  count: number
  /** Reviews rated Good or Easy (rating >= 3). */
  correct: number
}

export interface StatsForecast {
  /** Active cards already due now. */
  due_now: number
  /** Active cards becoming due in the next 24h (excludes due_now). */
  due_next_24h: number
  /** All active cards in the deck. */
  active_total: number
}

export interface HeatmapCell {
  /** ISO date (UTC), e.g. "2026-05-15". */
  date: string
  /** Number of reviews on that date. */
  count: number
}

export interface RecentSession {
  id: string
  started_at: string
  finished_at: string
  cards_reviewed: number
  cards_correct: number
}

export interface StatsResponse {
  reviews: {
    today: ReviewWindow
    last_7d: ReviewWindow
    last_30d: ReviewWindow
  }
  sessions: {
    today: number
    last_7d: number
  }
  forecast: StatsForecast
  /** Up to 365 entries — only days that had reviews. Days with zero reviews
   *  are omitted from the response; the client fills them in client-side. */
  heatmap: HeatmapCell[]
  /** Up to 10 most-recent finished sessions, newest first. */
  recent_sessions: RecentSession[]
  /** Server "now" — useful for the client to compute boundaries identically. */
  generated_at: string
}
