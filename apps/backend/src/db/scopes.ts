// Scope lifecycle: the scope list is CONFIG, not user data.
//
// The operator declares scopes in the backend env (SCOPES=…); boot
// upserts the rows so the slug → id mapping is stable for FKs, tokens
// and headers. Rows are never deleted — cards FK into them, and a
// disappearing scope would take its deck with it. Removing a scope from
// config merely stops the app from listing it.

import { eq } from 'drizzle-orm'
import { SCOPE_ACCENTS, SCOPE_SLUG_PATTERN, type ScopeAccent } from '@oxenfurt/shared'
import type { Db } from './client.ts'
import { scopes, type ScopeRow } from './schema.ts'

export interface ScopeConfigEntry {
  slug: string
  title: string
  emoji: string | null
  accent: ScopeAccent
}

export const DEFAULT_SCOPES_CONFIG = 'english:English:🇬🇧:indigo'

export class ScopesConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopesConfigError'
  }
}

/**
 * Parses `slug:Title:emoji:accent,slug:…`. Empty parts fall back to the
 * slug as the title; accent defaults to indigo. Throws ScopesConfigError
 * with a specific message on anything malformed — a typo'd scope config
 * must stop the boot, not silently half-work.
 */
export function parseScopesConfig(raw: string): ScopeConfigEntry[] {
  const entries: ScopeConfigEntry[] = []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const chunk = part.trim()
    if (chunk.length === 0) continue
    const fields = chunk.split(':').map((f) => f.trim())
    const slug = fields[0] ?? ''
    if (!SCOPE_SLUG_PATTERN.test(slug)) {
      throw new ScopesConfigError(
        `invalid scope slug "${slug}" — expected lowercase letters/digits/hyphens, max 32 chars`,
      )
    }
    if (seen.has(slug)) throw new ScopesConfigError(`duplicate scope slug "${slug}"`)
    seen.add(slug)
    const title = fields[1] && fields[1].length > 0 ? fields[1]! : slug
    const emoji = fields[2] && fields[2].length > 0 ? fields[2]! : null
    const accentRaw = fields[3] && fields[3].length > 0 ? fields[3]! : 'indigo'
    if (!SCOPE_ACCENTS.includes(accentRaw as ScopeAccent)) {
      throw new ScopesConfigError(
        `invalid accent "${accentRaw}" for scope "${slug}" — expected one of ${SCOPE_ACCENTS.join(', ')}`,
      )
    }
    entries.push({ slug, title, emoji, accent: accentRaw as ScopeAccent })
  }
  if (entries.length === 0) throw new ScopesConfigError('SCOPES must declare at least one scope')
  return entries
}

/**
 * Parses `slug=token,slug=token`. Returns entries in declaration order;
 * callers validate the slugs against the SCOPES config.
 */
export function parseIngestTokensConfig(raw: string): Array<{ slug: string; token: string }> {
  const entries: Array<{ slug: string; token: string }> = []
  for (const part of raw.split(',')) {
    const chunk = part.trim()
    if (chunk.length === 0) continue
    const eqIndex = chunk.indexOf('=')
    if (eqIndex <= 0 || eqIndex === chunk.length - 1) {
      throw new ScopesConfigError(`malformed INGEST_TOKENS entry "${chunk}" — expected slug=token`)
    }
    entries.push({ slug: chunk.slice(0, eqIndex).trim(), token: chunk.slice(eqIndex + 1).trim() })
  }
  return entries
}

/**
 * Upserts the configured scopes and returns their rows in CONFIG order.
 * The first entry is the default scope — the one a scope-less request
 * falls back to and the one the legacy INGEST_TOKEN belongs to.
 */
export async function syncScopes(db: Db, entries: ScopeConfigEntry[]): Promise<ScopeRow[]> {
  const rows: ScopeRow[] = []
  for (const entry of entries) {
    const [row] = await db
      .insert(scopes)
      .values({
        slug: entry.slug,
        title: entry.title,
        emoji: entry.emoji,
        accent: entry.accent,
      })
      .onConflictDoUpdate({
        target: scopes.slug,
        set: { title: entry.title, emoji: entry.emoji, accent: entry.accent },
      })
      .returning()
    rows.push(row!)
  }
  return rows
}

/** Loads all scope rows, ordered so the configured default comes first. */
export async function loadScopes(db: Db): Promise<ScopeRow[]> {
  return await db.select().from(scopes).orderBy(scopes.createdAt)
}

export async function scopeBySlug(db: Db, slug: string): Promise<ScopeRow | undefined> {
  const [row] = await db.select().from(scopes).where(eq(scopes.slug, slug))
  return row
}
