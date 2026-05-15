import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { signSession } from '../auth/jwt.ts'
import { getTestDb, resetTestDb } from '../db/testing.ts'
import { sessions } from '../db/schema.ts'
import { createSessionsRouter, finishSession } from './router.ts'

const conn = await getTestDb()
const noDb = conn === null

const JWT_SECRET = '0123456789abcdef0123456789abcdef-test'
const NOW = new Date('2026-01-01T12:00:00.000Z')

const buildApp = () =>
  createSessionsRouter({
    db: conn!.db,
    jwtSecret: JWT_SECRET,
    now: () => NOW,
  })

async function authHeader(): Promise<Record<string, string>> {
  const token = await signSession({ userId: 99 }, JWT_SECRET, { ttlSeconds: 900, now: NOW })
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

beforeEach(async () => {
  if (conn) await resetTestDb(conn.db)
})

// Don't close `conn` — shared singleton, see db/testing.ts.

describe.skipIf(noDb)('POST /', () => {
  test('returns 401 without a JWT', async () => {
    const res = await buildApp().request('/', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  test('creates a session and returns its id + start timestamp', async () => {
    const res = await buildApp().request('/', { method: 'POST', headers: await authHeader() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; started_at: string }
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i)
    expect(body.started_at).toBe(NOW.toISOString())

    const rows = await conn!.db.select().from(sessions)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.finishedAt).toBeNull()
    expect(rows[0]!.cardsReviewed).toBe(0)
    expect(rows[0]!.cardsCorrect).toBe(0)
  })
})

describe.skipIf(noDb)('POST /:id/finish', () => {
  async function createSession(): Promise<string> {
    const res = await buildApp().request('/', { method: 'POST', headers: await authHeader() })
    return ((await res.json()) as { id: string }).id
  }

  test('writes finished_at and totals', async () => {
    const id = await createSession()
    const finishAt = new Date(NOW.getTime() + 60_000)
    const res = await buildApp().request(`/${id}/finish`, {
      method: 'POST',
      headers: { ...(await authHeader()) },
      body: JSON.stringify({ cards_reviewed: 12, cards_correct: 10 }),
    })
    void finishAt
    expect(res.status).toBe(200)

    const [row] = await conn!.db.select().from(sessions).where(eq(sessions.id, id))
    expect(row!.finishedAt).not.toBeNull()
    expect(row!.cardsReviewed).toBe(12)
    expect(row!.cardsCorrect).toBe(10)
  })

  test('rejects a second finish on the same session', async () => {
    const id = await createSession()
    const headers = await authHeader()
    await buildApp().request(`/${id}/finish`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cards_reviewed: 5, cards_correct: 5 }),
    })
    const res = await buildApp().request(`/${id}/finish`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cards_reviewed: 99, cards_correct: 99 }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'already_finished' })

    // First-finish totals must not be clobbered.
    const [row] = await conn!.db.select().from(sessions).where(eq(sessions.id, id))
    expect(row!.cardsReviewed).toBe(5)
    expect(row!.cardsCorrect).toBe(5)
  })

  test('returns 404 for an unknown id', async () => {
    const res = await buildApp().request('/00000000-0000-0000-0000-000000000000/finish', {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ cards_reviewed: 1, cards_correct: 1 }),
    })
    expect(res.status).toBe(404)
  })

  test('returns 400 for a malformed id', async () => {
    const res = await buildApp().request('/not-a-uuid/finish', {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ cards_reviewed: 1, cards_correct: 1 }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 when cards_correct > cards_reviewed', async () => {
    const id = await createSession()
    const res = await buildApp().request(`/${id}/finish`, {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ cards_reviewed: 3, cards_correct: 5 }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_payload' })
  })

  test('returns 400 for negative counts', async () => {
    const id = await createSession()
    const res = await buildApp().request(`/${id}/finish`, {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ cards_reviewed: -1, cards_correct: 0 }),
    })
    expect(res.status).toBe(400)
  })

  test('finishSession helper works without an HTTP layer', async () => {
    const id = await createSession()
    const result = await finishSession(conn!.db, id, 7, 6, new Date(NOW.getTime() + 1000))
    expect(result).not.toBe('not_found')
    expect(result).not.toBe('already_finished')
  })
})

describe.skipIf(noDb)('GET /stats', () => {
  test('returns 401 without a JWT', async () => {
    const res = await buildApp().request('/stats')
    expect(res.status).toBe(401)
  })

  test('returns zero counters on an empty database', async () => {
    const res = await buildApp().request('/stats', { headers: await authHeader() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      reviews: { today: { count: number; correct: number } }
      sessions: { today: number; last_7d: number }
      forecast: { due_now: number; active_total: number }
      heatmap: unknown[]
      recent_sessions: unknown[]
      generated_at: string
    }
    expect(body.reviews.today.count).toBe(0)
    expect(body.sessions.today).toBe(0)
    expect(body.forecast.active_total).toBe(0)
    expect(body.heatmap).toEqual([])
    expect(body.recent_sessions).toEqual([])
    expect(body.generated_at).toBe(NOW.toISOString())
  })

  test('counts a finished session in sessions.today', async () => {
    const res = await buildApp().request('/', { method: 'POST', headers: await authHeader() })
    const id = ((await res.json()) as { id: string }).id
    await buildApp().request(`/${id}/finish`, {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ cards_reviewed: 7, cards_correct: 5 }),
    })
    const stats = await buildApp().request('/stats', { headers: await authHeader() })
    const body = (await stats.json()) as {
      sessions: { today: number }
      recent_sessions: Array<{ cards_reviewed: number; cards_correct: number }>
    }
    expect(body.sessions.today).toBe(1)
    expect(body.recent_sessions).toHaveLength(1)
    expect(body.recent_sessions[0]!.cards_reviewed).toBe(7)
    expect(body.recent_sessions[0]!.cards_correct).toBe(5)
  })

  test('unfinished sessions are excluded from recent_sessions', async () => {
    // Two starts, no finish — should not appear in recent_sessions.
    await buildApp().request('/', { method: 'POST', headers: await authHeader() })
    await buildApp().request('/', { method: 'POST', headers: await authHeader() })
    const stats = await buildApp().request('/stats', { headers: await authHeader() })
    const body = (await stats.json()) as { recent_sessions: unknown[]; sessions: { today: number } }
    expect(body.recent_sessions).toEqual([])
    expect(body.sessions.today).toBe(2)
  })
})
