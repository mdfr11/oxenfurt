import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { FsrsService, RATING } from '@oxenfurt/shared'
import { signSession } from '../auth/jwt.ts'
import { getTestDb, resetTestDb } from '../db/testing.ts'
import { cardReviews, cards } from '../db/schema.ts'
import { ingestCards } from '../ingest/cards.ts'
import { applyReview, createCardsRouter } from './router.ts'

const conn = await getTestDb()
const noDb = conn === null

const JWT_SECRET = '0123456789abcdef0123456789abcdef-test'
const NOW = new Date('2026-01-01T12:00:00.000Z')
const fsrs = new FsrsService({ enableFuzz: false })

const buildApp = () =>
  createCardsRouter({
    db: conn!.db,
    jwtSecret: JWT_SECRET,
    fsrs,
    now: () => NOW,
  })

async function authHeader(userId = 99): Promise<{ authorization: string }> {
  const token = await signSession({ userId }, JWT_SECRET, { ttlSeconds: 900, now: NOW })
  return { authorization: `Bearer ${token}` }
}

async function seedActiveVocab(term: string, dueAt: Date = NOW): Promise<string> {
  await ingestCards(
    conn!.db,
    fsrs,
    {
      cards: [
        {
          type: 'vocab',
          payload: {
            term,
            translation: 'тест',
            context_sentence: `Use ${term} in a sentence.`,
            context_term_start: 4,
            context_term_end: 4 + term.length,
          },
        },
      ],
    },
    dueAt,
  )
  const rows = await conn!.db.select().from(cards)
  return rows.find((r) => (r.payload as { term: string }).term === term)!.id
}

beforeEach(async () => {
  if (conn) await resetTestDb(conn.db)
})

afterAll(async () => {
  if (conn) await conn.close()
})

describe.skipIf(noDb)('GET /due', () => {
  test('returns 401 without a JWT', async () => {
    const res = await buildApp().request('/due')
    expect(res.status).toBe(401)
  })

  test('returns an empty list when there are no active cards', async () => {
    const res = await buildApp().request('/due', { headers: await authHeader() })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cards: [] })
  })

  test('returns active cards whose due is in the past', async () => {
    await seedActiveVocab('past', new Date(NOW.getTime() - 1000))
    const res = await buildApp().request('/due', { headers: await authHeader() })
    const body = (await res.json()) as { cards: Array<{ id: string }> }
    expect(body.cards).toHaveLength(1)
  })

  test('excludes draft and archived cards', async () => {
    await seedActiveVocab('one')
    // sneak in a draft theory card
    await ingestCards(
      conn!.db,
      fsrs,
      {
        cards: [
          {
            type: 'theory',
            payload: { question: 'q', answer: 'a' },
            source_quote: 'x',
          },
        ],
      },
      NOW,
    )
    const res = await buildApp().request('/due', { headers: await authHeader() })
    const body = (await res.json()) as { cards: Array<{ type: string }> }
    expect(body.cards.map((c) => c.type)).toEqual(['vocab'])
  })

  test('respects the limit query parameter', async () => {
    await seedActiveVocab('alpha', new Date(NOW.getTime() - 3000))
    await seedActiveVocab('beta', new Date(NOW.getTime() - 2000))
    await seedActiveVocab('gamma', new Date(NOW.getTime() - 1000))
    const res = await buildApp().request('/due?limit=2', { headers: await authHeader() })
    const body = (await res.json()) as { cards: unknown[] }
    expect(body.cards).toHaveLength(2)
  })
})

describe.skipIf(noDb)('POST /:id/review', () => {
  test('returns 400 for a non-UUID id', async () => {
    const res = await buildApp().request('/not-a-uuid/review', {
      method: 'POST',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({ rating: 3 }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 404 for an unknown card id', async () => {
    const res = await buildApp().request(
      '/00000000-0000-0000-0000-000000000000/review',
      {
        method: 'POST',
        headers: { ...(await authHeader()), 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 3 }),
      },
    )
    expect(res.status).toBe(404)
  })

  test('returns 400 for an out-of-range rating', async () => {
    const id = await seedActiveVocab('badrating')
    const res = await buildApp().request(`/${id}/review`, {
      method: 'POST',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({ rating: 7 }),
    })
    expect(res.status).toBe(400)
  })

  test('Good on a new card writes a review row and updates FSRS state', async () => {
    const id = await seedActiveVocab('updateme')
    const res = await buildApp().request(`/${id}/review`, {
      method: 'POST',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({ rating: RATING.Good }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { fsrs: { reps: number; fsrs_state: number } }
    expect(body.fsrs.reps).toBe(1)
    expect(body.fsrs.fsrs_state).toBeGreaterThan(0)

    const reviews = await conn!.db.select().from(cardReviews)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.rating).toBe(RATING.Good)
    expect(reviews[0]!.fsrsStateBefore).toBe(0)
  })

  test('applyReview returns null for a draft card (theory still pending approval)', async () => {
    await ingestCards(
      conn!.db,
      fsrs,
      {
        cards: [
          {
            type: 'theory',
            payload: { question: 'q', answer: 'a' },
            source_quote: 'q',
          },
        ],
      },
      NOW,
    )
    const draftRows = await conn!.db.select().from(cards)
    const result = await applyReview(conn!.db, fsrs, draftRows[0]!.id, RATING.Good, NOW)
    expect(result).toBeNull()
  })
})
