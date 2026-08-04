import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { FsrsService } from '@oxenfurt/shared'
import { getTestDb, resetTestDb } from '../db/testing.ts'
import { assignmentItems, assignments, cards } from '../db/schema.ts'
import { ingestCards } from '../ingest/cards.ts'
import {
  expireStaleAssignments,
  listAssignments,
  loadActiveAssignment,
  markCardCompleted,
} from './service.ts'

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

async function seedAssignment(cardIds: string[], dueAt: Date) {
  const [row] = await conn!.db
    .insert(assignments)
    .values({ title: 'Условные предложения', dueAt, rationale: 'Сыпался на уроке.' })
    .returning()
  await conn!.db.insert(assignmentItems).values(
    cardIds.map((cardId, i) => ({
      assignmentId: row!.id,
      cardId,
      groupLabel: i === 0 ? 'Забытое' : 'Слова с урока',
      groupKind: i === 0 ? ('weak' as const) : ('new' as const),
      position: i,
    })),
  )
  return row!.id
}

describe.skipIf(noDb)('expireStaleAssignments', () => {
  test('flips an active assignment past its deadline to expired', async () => {
    const ids = await seedCards(3)
    const assignmentId = await seedAssignment(ids, new Date('2026-08-03T21:00:00.000Z'))

    await expireStaleAssignments(conn!.db, NOW)

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('expired')
  })

  test('leaves an assignment whose deadline is still ahead', async () => {
    const ids = await seedCards(3)
    await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))

    await expireStaleAssignments(conn!.db, NOW)

    const [row] = await conn!.db.select().from(assignments)
    expect(row!.status).toBe('active')
  })

  test('is idempotent', async () => {
    const ids = await seedCards(3)
    await seedAssignment(ids, new Date('2026-08-03T21:00:00.000Z'))
    await expireStaleAssignments(conn!.db, NOW)
    await expireStaleAssignments(conn!.db, NOW)
    const rows = await conn!.db.select().from(assignments)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('expired')
  })
})

describe.skipIf(noDb)('loadActiveAssignment', () => {
  test('returns null when nothing is active', async () => {
    const result = await loadActiveAssignment(conn!.db, NOW)
    expect(result.assignment).toBeNull()
    expect(result.items).toEqual([])
  })

  test('returns items ordered by position with grouped counts', async () => {
    const ids = await seedCards(3)
    await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))

    const result = await loadActiveAssignment(conn!.db, NOW)

    expect(result.assignment!.total).toBe(3)
    expect(result.assignment!.completed).toBe(0)
    expect(result.items.map((i) => i.position)).toEqual([0, 1, 2])
    expect(result.assignment!.groups).toEqual([
      { label: 'Забытое', kind: 'weak', total: 1, completed: 0 },
      { label: 'Слова с урока', kind: 'new', total: 2, completed: 0 },
    ])
  })

  test('excludes archived cards from items and from the denominator', async () => {
    const ids = await seedCards(3)
    await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))
    await conn!.db.update(cards).set({ status: 'archived' }).where(eq(cards.id, ids[0]!))

    const result = await loadActiveAssignment(conn!.db, NOW)

    expect(result.assignment!.total).toBe(2)
    expect(result.items).toHaveLength(2)
    expect(result.assignment!.groups.map((g) => g.label)).toEqual(['Слова с урока'])
  })

  test('expires a stale assignment rather than returning it', async () => {
    const ids = await seedCards(3)
    await seedAssignment(ids, new Date('2026-08-03T21:00:00.000Z'))
    const result = await loadActiveAssignment(conn!.db, NOW)
    expect(result.assignment).toBeNull()
  })
})

describe.skipIf(noDb)('markCardCompleted', () => {
  test('stamps completed_at on the matching item', async () => {
    const ids = await seedCards(3)
    const assignmentId = await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))

    await markCardCompleted(conn!.db, ids[0]!, NOW)

    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt).not.toBeNull()
    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('active')
  })

  test('does not overwrite an existing completed_at', async () => {
    const ids = await seedCards(3)
    await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))
    const first = new Date('2026-08-04T09:00:00.000Z')
    await markCardCompleted(conn!.db, ids[0]!, first)
    await markCardCompleted(conn!.db, ids[0]!, NOW)

    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt!.toISOString()).toBe(first.toISOString())
  })

  test('flips the assignment to completed once the last item is taken', async () => {
    const ids = await seedCards(3)
    const assignmentId = await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))

    for (const id of ids) await markCardCompleted(conn!.db, id, NOW)

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('completed')
    expect(row!.completedAt).not.toBeNull()
  })

  test('ignores cards that belong to no active assignment', async () => {
    const ids = await seedCards(3)
    await markCardCompleted(conn!.db, ids[0]!, NOW)
    const items = await conn!.db.select().from(assignmentItems)
    expect(items).toHaveLength(0)
  })

  test('archived items do not block completion', async () => {
    const ids = await seedCards(3)
    const assignmentId = await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))
    await conn!.db.update(cards).set({ status: 'archived' }).where(eq(cards.id, ids[2]!))

    await markCardCompleted(conn!.db, ids[0]!, NOW)
    await markCardCompleted(conn!.db, ids[1]!, NOW)

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('completed')
  })
})

describe.skipIf(noDb)('listAssignments', () => {
  test('returns newest first with progress counts', async () => {
    const ids = await seedCards(3)
    await conn!.db.insert(assignments).values({
      title: 'Старое',
      status: 'expired',
      dueAt: new Date('2026-07-30T21:00:00.000Z'),
      createdAt: new Date('2026-07-28T10:00:00.000Z'),
    })
    await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))
    await markCardCompleted(conn!.db, ids[0]!, NOW)

    const rows = await listAssignments(conn!.db, NOW)

    expect(rows).toHaveLength(2)
    expect(rows[0]!.title).toBe('Условные предложения')
    expect(rows[0]!.completed).toBe(1)
    expect(rows[0]!.total).toBe(3)
    expect(rows[1]!.title).toBe('Старое')
    expect(rows[1]!.total).toBe(0)
  })
})
