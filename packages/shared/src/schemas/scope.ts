// Scope DTOs. A scope is one "academy" inside the single-user app: one
// agent (Hermes profile), one card deck, one assignment slot, one stats
// history. The Mini App fetches the list once and renders the switcher;
// every subsequent request carries the active scope in the X-Scope
// header, and agent ingest carries it implicitly via its per-scope
// token.

export const SCOPE_ACCENTS = ['indigo', 'emerald', 'amber', 'rose', 'sky', 'violet'] as const
export type ScopeAccent = (typeof SCOPE_ACCENTS)[number]

/** Slug rules: the config file, env vars and URL headers all use it. */
export const SCOPE_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

export interface ScopeDto {
  slug: string
  title: string
  emoji: string | null
  /** Palette key the Mini App maps to its accent color. */
  accent: string | null
}

export interface ScopeSummaryDto extends ScopeDto {
  /** Active cards due right now — the pill badge. */
  due_count: number
  /** Active cards with stability >= 10 days — the per-scope rank input. */
  learned_count: number
  /** Whether this scope currently owns an active assignment. */
  has_active_assignment: boolean
}

export interface ScopesResponse {
  scopes: ScopeSummaryDto[]
}
