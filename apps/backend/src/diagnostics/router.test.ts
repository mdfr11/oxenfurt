import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { FsrsService } from '@oxenfurt/shared'
import { getTestDb, resetTestDb } from '../db/testing.ts'
import { assignmentItems, assignments, cards } from '../db/schema.ts'
import { ingestCards } from '../ingest/cards.ts'
import { createDiagnosticsRouter } from './router.ts'

const conn = await getTestDb()
const noDb = conn === null
const INGEST_TOKEN = 'test-ingest-token-diagnostics'
const NOW = new Date('2026-08-04T12:00:00.000Z')
const fsrs = new FsrsService({ enableFuzz: false })

beforeEach(async () => {
  if (conn) await resetTestDb(conn.db)
})

async function seedCards(count: number, source = 'lesson-2026-07-28'): Promise<string[]> {
  await ingestCards(
    conn!.db,
    fsrs,
    {
      cards: Array.from({ length: count }, (_, i) => ({
        type: 'vocab' as const,
        payload: {
          term: `${source}-term${i}`,
          translation: `перевод${i}`,
          context_sentence: `A sentence with term${i} inside.`,
          context_term_start: 14,
          context_term_end: 20,
        },
        source,
      })),
    },
    NOW,
  )
  const rows = await conn!.db.select({ id: cards.id }).from(cards).where(eq(cards.source, source))
  return rows.map((r) => r.id)
}

function app() {
  return createDiagnosticsRouter({ db: conn!.db, ingestToken: INGEST_TOKEN, now: () => NOW })
}

function get() {
  return app().request('/', { headers: { authorization: `Bearer ${INGEST_TOKEN}` } })
}

describe.skipIf(noDb)('GET /agent/diagnostics', () => {
  test('401 without the ingest token', async () => {
    const res = await app().request('/', { headers: { authorization: 'Bearer nope-nope-nope' } })
    expect(res.status).toBe(401)
  })

  test('reports overdue cards with days_overdue', async () => {
    const ids = await seedCards(2)
    await conn!.db
      .update(cards)
      .set({ due: new Date('2026-07-28T12:00:00.000Z') })
      .where(eq(cards.id, ids[0]!))

    const json = (await (await get()).json()) as {
      summary: { overdue: number }
      overdue: { card_id: string; days_overdue: number; label: string }[]
    }
    expect(json.summary.overdue).toBe(1)
    expect(json.overdue).toHaveLength(1)
    expect(json.overdue[0]!.card_id).toBe(ids[0]!)
    expect(json.overdue[0]!.days_overdue).toBe(7)
    expect(json.overdue[0]!.label).toBe('lesson-2026-07-28-term0')
  })

  test('reports leeches at four lapses or more', async () => {
    const ids = await seedCards(3)
    await conn!.db.update(cards).set({ lapses: 4 }).where(eq(cards.id, ids[0]!))
    await conn!.db.update(cards).set({ lapses: 3 }).where(eq(cards.id, ids[1]!))

    const json = (await (await get()).json()) as {
      summary: { leeches: number }
      leeches: { card_id: string }[]
    }
    expect(json.summary.leeches).toBe(1)
    expect(json.leeches.map((c: { card_id: string }) => c.card_id)).toEqual([ids[0]!])
  })

  test('excludes archived cards everywhere', async () => {
    const ids = await seedCards(2)
    await conn!.db
      .update(cards)
      .set({ status: 'archived', lapses: 9, due: new Date('2026-07-01T12:00:00.000Z') })
      .where(eq(cards.id, ids[0]!))

    const json = (await (await get()).json()) as {
      summary: { active_cards: number }
      overdue: unknown[]
      leeches: unknown[]
    }
    expect(json.summary.active_cards).toBe(1)
    expect(json.overdue).toHaveLength(0)
    expect(json.leeches).toHaveLength(0)
  })

  test('groups recent sources with counts', async () => {
    await seedCards(2, 'lesson-2026-07-28')
    await seedCards(3, 'lesson-2026-08-01')

    const json = (await (await get()).json()) as {
      recent_sources: { source: string; cards: number }[]
    }
    const labels = json.recent_sources.map((s: { source: string; cards: number }) => [s.source, s.cards])
    expect(labels).toContainEqual(['lesson-2026-07-28', 2])
    expect(labels).toContainEqual(['lesson-2026-08-01', 3])
  })

  test('last_assignment is null when none exists', async () => {
    const json = (await (await get()).json()) as { last_assignment: unknown }
    expect(json.last_assignment).toBeNull()
  })

  test('last_assignment reports unfinished cards of the newest assignment', async () => {
    const ids = await seedCards(3)
    const [row] = await conn!.db
      .insert(assignments)
      .values({ title: 'Пассивный залог', status: 'expired', dueAt: new Date('2026-08-01T21:00:00.000Z') })
      .returning()
    await conn!.db.insert(assignmentItems).values(
      ids.map((cardId, i) => ({
        assignmentId: row!.id,
        cardId,
        groupLabel: 'Тема',
        groupKind: 'topic' as const,
        position: i,
        completedAt: i === 0 ? NOW : null,
      })),
    )

    const json = (await (await get()).json()) as {
      last_assignment: {
        title: string
        status: string
        completed: number
        total: number
        unfinished_card_ids: string[]
      }
    }
    expect(json.last_assignment.title).toBe('Пассивный залог')
    expect(json.last_assignment.status).toBe('expired')
    expect(json.last_assignment.completed).toBe(1)
    expect(json.last_assignment.total).toBe(3)
    expect(json.last_assignment.unfinished_card_ids.sort()).toEqual([ids[1]!, ids[2]!].sort())
  })
})
