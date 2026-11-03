import { sql } from 'drizzle-orm'
import { createDb, type Db, type DbConnection } from './client.ts'
import { runMigrations } from './migrate.ts'
import { DEFAULT_SCOPES_CONFIG, parseScopesConfig, syncScopes } from './scopes.ts'
import type { ScopeRow } from './schema.ts'
import { toScopeRef, type ScopeRef } from '../middleware/scope.ts'

/**
 * Returns a Db connection seeded against the `TEST_DATABASE_URL` env var, or
 * `null` if the variable is not set or the database is unreachable. Tests
 * using this helper should call `test.skipIf(db === null)` to skip when no
 * test DB is available — CI runs against a real Postgres, local quick-iter
 * runs may not have one.
 *
 * The connection is a **module-level singleton** intentionally: Bun runs all
 * test files in the same process, so a fresh `createDb(...)` per file would
 * exhaust the pool quickly. The trade-off: test files MUST NOT call
 * `conn.close()` in afterAll — closing the shared connection mid-suite
 * makes every subsequent file fail with `CONNECTION_ENDED`. The connection
 * is reaped on process exit by Bun.
 *
 * Migrations are applied once on first access. Tables are truncated between
 * tests via `resetTestDb`.
 */
let cached: DbConnection | null = null
let initFailed = false

export async function getTestDb(): Promise<DbConnection | null> {
  if (cached) return cached
  if (initFailed) return null
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    initFailed = true
    return null
  }
  try {
    await runMigrations(url)
    cached = createDb(url, { max: 4 })
    return cached
  } catch {
    initFailed = true
    return null
  }
}

/** Default scope rows for tests: one 'english' scope, matching stock. */
export async function seedDefaultScope(db: Db): Promise<ScopeRow[]> {
  defaultScopes = await syncScopes(db, parseScopesConfig(DEFAULT_SCOPES_CONFIG))
  return defaultScopes
}

/** Scope rows from the last resetTestDb/seedDefaultScope — for router deps. */
let defaultScopes: ScopeRow[] = []

export function testScopes(): ScopeRow[] {
  if (defaultScopes.length === 0) throw new Error('resetTestDb has not run yet')
  return defaultScopes
}

/** The default scope as routers and ingest helpers expect it. */
export function testScopeRef(): ScopeRef {
  return toScopeRef(testScopes()[0]!)
}

/**
 * Truncates everything and re-seeds the default scope. Returns the fresh
 * scope rows so tests can reference `scope.id` in direct inserts — every
 * card/assignment/session row now needs it.
 */
export async function resetTestDb(db: Db): Promise<ScopeRow[]> {
  // Order matters only insofar as CASCADE handles FK chains. card_questions
  // and card_reviews both FK into cards; truncating cards with CASCADE
  // clears them, but listing them explicitly keeps the intent obvious and
  // protects against future schema changes that drop the cascade.
  // scopes comes last so FK-referencing rows die with their cards first.
  await db.execute(sql`
    TRUNCATE TABLE assignment_items, assignments, card_questions, card_reviews, sessions, cards, scopes
    RESTART IDENTITY CASCADE
  `)
  return await seedDefaultScope(db)
}
