import { beforeEach, describe, expect, test } from 'bun:test'
import { FsrsService } from '@oxenfurt/shared'
import { getTestDb, resetTestDb } from '../db/testing.ts'
import { assignmentItems, assignments, cards } from '../db/schema.ts'
import { ingestCards } from '../ingest/cards.ts'

const conn = await getTestDb()
const noDb = conn === null
const NOW = new Date('2026-08-04T12:00:00.000Z')
const fsrs = new FsrsService({ enableFuzz: false })

beforeEach(async () => {
  if (conn) await resetTestDb(conn.db)
})

async function seedCards(count: number): Promise<string[]> {
  await ingestCards(
    conn!.db,
    fsrs,
    {
      cards: Array.from({ length: count }, (_, i) => ({
        type: 'vocab' as const,
        payload: {
          term: `term${i}`,
          translation: `перевод${i}`,
          context_sentence: `A sentence with term${i} inside.`,
          context_term_start: 14,
          context_term_end: 14 + `term${i}`.length,
        },
        source: 'lesson-2026-07-28',
      })),
    },
    NOW,
  )
  const rows = await conn!.db.select({ id: cards.id }).from(cards)
  return rows.map((r) => r.id)
}

describe.skipIf(noDb)('assignments schema', () => {
  test('allows only one active assignment', async () => {
    await conn!.db.insert(assignments).values({
      title: 'First',
      dueAt: new Date('2026-08-06T21:00:00.000Z'),
    })

    let threw = false
    try {
      await conn!.db.insert(assignments).values({
        title: 'Second',
        dueAt: new Date('2026-08-07T21:00:00.000Z'),
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test('allows many non-active assignments alongside one active', async () => {
    await conn!.db.insert(assignments).values([
      { title: 'Done', status: 'completed', dueAt: NOW },
      { title: 'Missed', status: 'expired', dueAt: NOW },
      { title: 'Live', status: 'active', dueAt: new Date('2026-08-06T21:00:00.000Z') },
    ])
    const rows = await conn!.db.select().from(assignments)
    expect(rows).toHaveLength(3)
  })

  test('deleting an assignment cascades to its items', async () => {
    const [cardId] = await seedCards(1)
    const [row] = await conn!.db
      .insert(assignments)
      .values({ title: 'Live', dueAt: new Date('2026-08-06T21:00:00.000Z') })
      .returning()
    await conn!.db.insert(assignmentItems).values({
      assignmentId: row!.id,
      cardId: cardId!,
      groupLabel: 'Слова с урока',
      groupKind: 'new',
      position: 0,
    })

    await conn!.db.delete(assignments)
    const items = await conn!.db.select().from(assignmentItems)
    expect(items).toHaveLength(0)
  })
})
