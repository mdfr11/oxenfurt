import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
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

async function seedDraftTheory(
  question: string,
  answer = 'A',
  sourceQuote = 'quote',
): Promise<string> {
  await ingestCards(
    conn!.db,
    fsrs,
    {
      cards: [
        {
          type: 'theory',
          payload: { question, answer },
          source_quote: sourceQuote,
        },
      ],
    },
    NOW,
  )
  const rows = await conn!.db.select().from(cards)
  return rows.find((r) => (r.payload as { question: string }).question === question)!.id
}

describe.skipIf(noDb)('GET /drafts', () => {
  test('returns 401 without a JWT', async () => {
    const res = await buildApp().request('/drafts')
    expect(res.status).toBe(401)
  })

  test('returns empty list when nothing is in draft', async () => {
    const res = await buildApp().request('/drafts', { headers: await authHeader() })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cards: [] })
  })

  test('returns theory cards with status=draft in creation order', async () => {
    await seedDraftTheory('Q1')
    await seedDraftTheory('Q2')
    await seedActiveVocab('not-a-draft')

    const res = await buildApp().request('/drafts', { headers: await authHeader() })
    const body = (await res.json()) as {
      cards: Array<{ type: string; payload: { question: string }; created_at: string }>
    }
    expect(body.cards).toHaveLength(2)
    expect(body.cards.map((c) => c.payload.question)).toEqual(['Q1', 'Q2'])
    expect(body.cards.every((c) => c.type === 'theory')).toBe(true)
    expect(typeof body.cards[0]!.created_at).toBe('string')
  })
})

describe.skipIf(noDb)('POST /:id/approve', () => {
  test('flips a draft theory card to active', async () => {
    const id = await seedDraftTheory('When to use the perfect tense?')
    const res = await buildApp().request(`/${id}/approve`, {
      method: 'POST',
      headers: await authHeader(),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'active' })

    const [row] = await conn!.db.select().from(cards).where(eq(cards.id, id))
    expect(row!.status).toBe('active')
  })

  test('returns 400 when approving a non-draft card (already active vocab)', async () => {
    const id = await seedActiveVocab('already-active')
    const res = await buildApp().request(`/${id}/approve`, {
      method: 'POST',
      headers: await authHeader(),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'not_in_draft' })
  })

  test('returns 404 for an unknown id', async () => {
    const res = await buildApp().request(
      '/00000000-0000-0000-0000-000000000000/approve',
      { method: 'POST', headers: await authHeader() },
    )
    expect(res.status).toBe(404)
  })

  test('returns 400 for a malformed id', async () => {
    const res = await buildApp().request('/not-a-uuid/approve', {
      method: 'POST',
      headers: await authHeader(),
    })
    expect(res.status).toBe(400)
  })
})

describe.skipIf(noDb)('POST /:id/skip', () => {
  test('archives a draft theory card', async () => {
    const id = await seedDraftTheory('Some bad theory')
    const res = await buildApp().request(`/${id}/skip`, {
      method: 'POST',
      headers: await authHeader(),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'archived' })

    const [row] = await conn!.db.select().from(cards).where(eq(cards.id, id))
    expect(row!.status).toBe('archived')
  })

  test('archived card does not show in /due', async () => {
    const id = await seedDraftTheory('Skip me')
    await buildApp().request(`/${id}/skip`, {
      method: 'POST',
      headers: await authHeader(),
    })
    const due = await buildApp().request('/due', { headers: await authHeader() })
    const body = (await due.json()) as { cards: unknown[] }
    expect(body.cards).toHaveLength(0)
  })

  test('approved card shows up in /due', async () => {
    const id = await seedDraftTheory('Approve me')
    await buildApp().request(`/${id}/approve`, {
      method: 'POST',
      headers: await authHeader(),
    })
    const due = await buildApp().request('/due', { headers: await authHeader() })
    const body = (await due.json()) as { cards: Array<{ id: string }> }
    expect(body.cards).toHaveLength(1)
    expect(body.cards[0]!.id).toBe(id)
  })
})
