import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { FsrsService } from '@oxenfurt/shared'
import { getTestDb, resetTestDb } from '../db/testing.ts'
import { assignmentItems, assignments, cards } from '../db/schema.ts'
import { ingestCards } from '../ingest/cards.ts'
import { signSession } from '../auth/jwt.ts'
import { createAgentAssignmentsRouter, createUserAssignmentsRouter } from './router.ts'

const conn = await getTestDb()
const noDb = conn === null
const INGEST_TOKEN = 'test-ingest-token-assignments'
const NOW = new Date('2026-08-04T12:00:00.000Z')
const DUE = '2026-08-06T21:00:00.000Z'
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

function agentApp() {
  return createAgentAssignmentsRouter({ db: conn!.db, ingestToken: INGEST_TOKEN, now: () => NOW })
}

function body(cardIds: string[], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: 'Условные предложения и лексика 28 июля',
    rationale: 'Второй кондиционал сыпался весь урок.',
    due_at: DUE,
    source: 'lesson-2026-07-28',
    items: cardIds.map((card_id, i) => ({
      card_id,
      group_label: i === 0 ? 'Забытое' : 'Слова с урока',
      group_kind: i === 0 ? 'weak' : 'new',
    })),
    ...overrides,
  })
}

function post(cardIds: string[], overrides: Record<string, unknown> = {}, token = INGEST_TOKEN) {
  return agentApp().request('/', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body(cardIds, overrides),
  })
}

describe.skipIf(noDb)('POST /agent/assignments', () => {
  test('401 without the ingest token', async () => {
    const ids = await seedCards(3)
    const res = await post(ids, {}, 'wrong-token-wrong-token')
    expect(res.status).toBe(401)
  })

  test('creates an assignment with positioned items', async () => {
    const ids = await seedCards(3)
    const res = await post(ids)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ assignment_id: expect.any(String), items: 3 })

    const items = await conn!.db.select().from(assignmentItems)
    expect(items.map((i) => i.position).sort()).toEqual([0, 1, 2])
    expect(items.find((i) => i.cardId === ids[0])!.groupKind).toBe('weak')
  })

  test('400 invalid_payload when fewer than 3 items', async () => {
    const ids = await seedCards(3)
    const res = await post(ids.slice(0, 2))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_payload')
  })

  test('400 invalid_due_at when the deadline is in the past', async () => {
    const ids = await seedCards(3)
    const res = await post(ids, { due_at: '2026-08-03T21:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_due_at')
  })

  test('400 invalid_due_at when the deadline is more than 30 days out', async () => {
    const ids = await seedCards(3)
    const res = await post(ids, { due_at: '2026-09-10T21:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_due_at')
  })

  test('400 duplicate_cards when the same card appears twice', async () => {
    const ids = await seedCards(3)
    const res = await post([ids[0]!, ids[0]!, ids[1]!])
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('duplicate_cards')
  })

  test('400 unknown_cards listing ids that do not exist', async () => {
    const ids = await seedCards(3)
    const ghost = '99999999-9999-4999-8999-999999999999'
    const res = await post([ids[0]!, ids[1]!, ghost])
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string; card_ids: string[] }
    expect(json.error).toBe('unknown_cards')
    expect(json.card_ids).toEqual([ghost])
  })

  test('400 unknown_cards when a card is archived', async () => {
    const ids = await seedCards(3)
    await conn!.db.update(cards).set({ status: 'archived' }).where(eq(cards.id, ids[2]!))
    const res = await post(ids)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('unknown_cards')
  })

  test('409 assignment_active when one is already live', async () => {
    const ids = await seedCards(3)
    await post(ids)
    const res = await post(ids)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('assignment_active')
  })

  test('concurrent creates: exactly one 200, one 409, one active row', async () => {
    const ids = await seedCards(3)
    const [a, b] = await Promise.all([post(ids), post(ids)])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 409])

    const live = await conn!.db.select().from(assignments).where(eq(assignments.status, 'active'))
    expect(live).toHaveLength(1)
  })

  test('replace:true expires the previous assignment', async () => {
    const ids = await seedCards(3)
    const first = await post(ids)
    const firstId = ((await first.json()) as { assignment_id: string }).assignment_id
    const res = await post(ids, { replace: true })
    expect(res.status).toBe(200)

    const [previous] = await conn!.db.select().from(assignments).where(eq(assignments.id, firstId))
    expect(previous!.status).toBe('expired')
    const live = await conn!.db.select().from(assignments).where(eq(assignments.status, 'active'))
    expect(live).toHaveLength(1)
  })

  test('an assignment past its deadline does not block a new one', async () => {
    const ids = await seedCards(3)
    await post(ids)
    await conn!.db
      .update(assignments)
      .set({ dueAt: new Date('2026-08-03T21:00:00.000Z') })
      .where(eq(assignments.status, 'active'))

    const res = await post(ids)
    expect(res.status).toBe(200)
  })
})

const JWT_SECRET = '0123456789abcdef0123456789abcdef-assign'

async function userHeader(): Promise<string> {
  const token = await signSession({ userId: 1 }, JWT_SECRET, { ttlSeconds: 900, now: NOW })
  return `Bearer ${token}`
}

function userApp() {
  return createUserAssignmentsRouter({
    db: conn!.db,
    jwtSecret: JWT_SECRET,
    ingestToken: INGEST_TOKEN,
    now: () => NOW,
  })
}

describe.skipIf(noDb)('GET /assignments/active', () => {
  test('401 without auth', async () => {
    const res = await userApp().request('/active')
    expect(res.status).toBe(401)
  })

  test('returns null when nothing is active', async () => {
    const res = await userApp().request('/active', { headers: { authorization: await userHeader() } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ assignment: null, items: [] })
  })

  test('returns the assignment with card DTOs and groups', async () => {
    const ids = await seedCards(3)
    await post(ids)

    const res = await userApp().request('/active', { headers: { authorization: await userHeader() } })
    const json = (await res.json()) as {
      assignment: { title: string; total: number; completed: number; groups: unknown[] }
      items: { card: { id: string; fsrs: { due: string } } }[]
    }

    expect(json.assignment.title).toBe('Условные предложения и лексика 28 июля')
    expect(json.assignment.total).toBe(3)
    expect(json.assignment.completed).toBe(0)
    expect(json.assignment.groups).toHaveLength(2)
    expect(json.items).toHaveLength(3)
    expect(json.items[0]!.card.id).toBe(ids[0]!)
    expect(json.items[0]!.card.fsrs.due).toBeString()
  })

  test('accepts the ingest token too', async () => {
    const ids = await seedCards(3)
    await post(ids)
    const res = await userApp().request('/active', {
      headers: { authorization: `Bearer ${INGEST_TOKEN}` },
    })
    expect(res.status).toBe(200)
  })
})

describe.skipIf(noDb)('GET /assignments', () => {
  test('lists history newest first', async () => {
    const ids = await seedCards(3)
    await post(ids)
    const res = await userApp().request('/', { headers: { authorization: await userHeader() } })
    const json = (await res.json()) as { assignments: { total: number; status: string }[] }
    expect(json.assignments).toHaveLength(1)
    expect(json.assignments[0]!.total).toBe(3)
    expect(json.assignments[0]!.status).toBe('active')
  })
})
