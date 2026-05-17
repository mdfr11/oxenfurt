import { beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { getTestDb, resetTestDb } from './testing.ts'
import { seedDemo } from './seed-demo.ts'

const conn = await getTestDb()
const noDb = conn === null
const TEST_URL = process.env.TEST_DATABASE_URL ?? ''

beforeEach(async () => {
  if (conn) await resetTestDb(conn.db)
})

describe.skipIf(noDb)('seedDemo', () => {
  test('inserts the full demo set across 3 lessons on a fresh DB', async () => {
    const result = await seedDemo(TEST_URL)
    expect(result.skipped).toBe(false)
    expect(result.inserted).toBeGreaterThan(20)

    const [row] = await conn!.db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM cards WHERE source LIKE 'demo-lesson-%'
    `)
    expect(Number(row?.count)).toBe(result.inserted)
  })

  test('second run is a no-op (idempotent — does not duplicate)', async () => {
    const first = await seedDemo(TEST_URL)
    expect(first.skipped).toBe(false)
    const totalAfterFirst = first.inserted

    const second = await seedDemo(TEST_URL)
    expect(second).toEqual({ inserted: 0, skipped: true })

    const [row] = await conn!.db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM cards WHERE source LIKE 'demo-lesson-%'
    `)
    expect(Number(row?.count)).toBe(totalAfterFirst)
  })

  test('seeded mix covers all three card types', async () => {
    await seedDemo(TEST_URL)
    const rows = await conn!.db.execute<{ type: string; n: string }>(sql`
      SELECT type, COUNT(*)::text AS n FROM cards
      WHERE source LIKE 'demo-lesson-%'
      GROUP BY type
    `)
    const byType = Object.fromEntries(rows.map((r) => [r.type, Number(r.n)]))
    expect(byType['vocab']).toBeGreaterThan(0)
    expect(byType['phrase']).toBeGreaterThan(0)
    expect(byType['theory']).toBeGreaterThan(0)
  })

  test('FSRS state is self-consistent on seeded cards', async () => {
    await seedDemo(TEST_URL)
    const rows = await conn!.db.execute<{
      fsrs_state: number
      reps: number
      stability: number
      due: string
    }>(sql`
      SELECT fsrs_state, reps, stability, due FROM cards
      WHERE source LIKE 'demo-lesson-%'
    `)
    for (const r of rows) {
      expect(Number.isFinite(r.stability)).toBe(true)
      // FSRS state codes: 0=new, 1=learning, 2=review, 3=relearning.
      expect([0, 1, 2, 3]).toContain(r.fsrs_state)
      // reps must be a non-negative integer.
      expect(r.reps).toBeGreaterThanOrEqual(0)
      // `due` must be a parseable ISO timestamp.
      expect(Number.isNaN(new Date(r.due).getTime())).toBe(false)
    }
  })
})
