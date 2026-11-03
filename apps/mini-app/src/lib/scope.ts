// The active scope — module-level store, not React context.
//
// A scope is ambient state the whole data layer needs (every request
// carries it in X-Scope), so it lives outside the tree: `fetchWithAuth`
// reads it at call time and components subscribe via `useScope()` when
// they render scope-dependent UI or put the scope into query keys.
//
// Switching scope is conceptually switching decks: the persisted
// practice session, the assignment on screen, the due queue — all of it
// belongs to exactly one scope at a time.

import { useSyncExternalStore } from 'react'

const SCOPE_KEY = 'oxenfurt_scope'

let currentSlug: string | null = loadSlug()
const listeners = new Set<() => void>()

function loadSlug(): string | null {
  try {
    return localStorage.getItem(SCOPE_KEY)
  } catch {
    return null
  }
}

export function getScopeSlug(): string | null {
  return currentSlug
}

export function setScopeSlug(slug: string | null): void {
  if (slug === currentSlug) return
  currentSlug = slug
  try {
    if (slug === null) localStorage.removeItem(SCOPE_KEY)
    else localStorage.setItem(SCOPE_KEY, slug)
  } catch {
    // Private mode / storage disabled — the in-memory value still works.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Re-renders on scope switch. `null` until the scopes list lands and a
 *  slug (stored or default) has been resolved. */
export function useScopeSlug(): string | null {
  return useSyncExternalStore(subscribe, getScopeSlug)
}

// Accent palette ------------------------------------------------------------
//
// The backend sends a palette KEY; the hex lives here so a stray value
// can never inject a color. Mid-tones readable on both the light and
// dark app themes.
const ACCENT_COLORS: Record<string, string> = {
  indigo: '#6366f1',
  emerald: '#10b981',
  amber: '#f59e0b',
  rose: '#f43f5e',
  sky: '#0ea5e9',
  violet: '#8b5cf6',
}

export function accentColor(accent: string | null | undefined): string {
  return (accent !== null && accent !== undefined && ACCENT_COLORS[accent]) || ACCENT_COLORS.indigo!
}
