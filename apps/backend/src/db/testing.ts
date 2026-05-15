import { sql } from 'drizzle-orm'
import { createDb, type Db, type DbConnection } from './client.ts'
import { runMigrations } from './migrate.ts'

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

export async function resetTestDb(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE card_reviews, sessions, cards RESTART IDENTITY CASCADE`)
}
