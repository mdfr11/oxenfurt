import type { DueCardDto } from '@oxenfurt/shared'
import type { PracticeMode } from './practiceMode'

// Persisted state of an interrupted practice session. Survives across app
// restarts so the user can close Telegram mid-session and pick up where
// they left off. Kept on the client only — losing it just means the next
// open lands on Home with no resume option, which is harmless.

const STORAGE_KEY = 'oxenfurt_session'
// Beyond ~12h a "paused" session is more confusing than useful — FSRS
// schedules may have shifted, the user's state of mind certainly has.
// Anything older we treat as expired and silently drop.
const MAX_AGE_MS = 12 * 60 * 60 * 1000

export interface SessionStats {
  total: number
  correct: number
}

export interface PersistedSession {
  mode: PracticeMode
  cards: DueCardDto[]
  currentIndex: number
  stats: SessionStats
  savedAt: number
}

export function saveSession(s: PersistedSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // localStorage full or unavailable — fine, resume is best-effort.
  }
}

export function loadSession(mode?: PracticeMode): PersistedSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<PersistedSession>
    if (
      typeof parsed.savedAt !== 'number' ||
      !Array.isArray(parsed.cards) ||
      parsed.cards.length === 0 ||
      typeof parsed.currentIndex !== 'number' ||
      typeof parsed.mode !== 'string'
    ) {
      return null
    }
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      clearSession()
      return null
    }
    if (mode !== undefined && parsed.mode !== mode) return null
    return parsed as PersistedSession
  } catch {
    return null
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

/** Sanity check: is there at least one un-rated card left in the queue? */
export function hasUnfinishedSession(s: PersistedSession): boolean {
  return s.currentIndex < s.cards.length
}
