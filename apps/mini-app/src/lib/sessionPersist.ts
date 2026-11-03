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
  /** Which scope the paused cards belong to — a session never crosses
   *  scopes, and Home must not offer to resume it under another one. */
  scope: string | null
  cards: DueCardDto[]
  currentIndex: number
  stats: SessionStats
  savedAt: number
}

// In-tab pub-sub. localStorage's own `storage` event only fires for OTHER
// tabs, so Home (which keeps mounted across screen changes) needs an
// explicit signal to know when PracticeSession just cleared the session.
// Without this it kept showing the stale "Незаконченная 9 / 10" badge.
const subscribers = new Set<() => void>()
function notify(): void {
  for (const cb of subscribers) cb()
}
export function subscribeToSession(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function saveSession(s: PersistedSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    notify()
  } catch {
    // localStorage full or unavailable — fine, resume is best-effort.
  }
}

export function loadSession(mode?: PracticeMode, scope?: string | null): PersistedSession | null {
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
    // A pause belongs to the scope it was started in. When the caller
    // names a scope, a session saved in another one simply doesn't exist
    // for them — it stays persisted for when they switch back.
    if (scope !== undefined && (parsed.scope ?? null) !== scope) return null
    const session = { ...parsed, scope: parsed.scope ?? null } as PersistedSession
    // Older clients persisted cards inserted by Again. Keep the reviewed
    // history and cursor for accurate progress, but never resume a repeat
    // of an answered card or multiple copies of an unanswered card.
    const history = session.cards.slice(0, session.currentIndex)
    const seen = new Set(history.map(card => card.id))
    const remaining = session.cards.slice(session.currentIndex).filter(card => {
      if (seen.has(card.id)) return false
      seen.add(card.id)
      return true
    })
    if (remaining.length === 0) {
      clearSession()
      return null
    }
    return { ...session, cards: [...history, ...remaining] }
  } catch {
    return null
  }
}

/**
 * One-shot upgrade for pauses saved before scopes existed. Those pauses
 * were created in the app's only deck, which is now the default (first
 * configured) scope — stamp it so loadSession's scope match lets them
 * resurface instead of silently orphaning on the other side of the
 * upgrade. No-op for pauses that already carry a scope, and for a
 * missing/garbled store entry.
 */
export function adoptLegacyPause(defaultScope: string): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return
    const parsed = JSON.parse(raw) as Partial<PersistedSession>
    if (parsed.scope !== undefined && parsed.scope !== null) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...parsed, scope: defaultScope }))
    notify()
  } catch {
    // Best-effort, same as the rest of this module.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
    notify()
  } catch {
    // ignore
  }
}

