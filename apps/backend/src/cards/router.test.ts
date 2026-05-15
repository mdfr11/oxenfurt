import { beforeEach, describe, expect, test } from 'bun:test'
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

// NB: we don't close `conn` in afterAll — it's a module-level singleton
// shared across all test files in the same Bun process. See db/testing.ts.

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

  test('returns both vocab and theory when both are active', async () => {
    // Sanity check that the draft-gate is well and truly gone — theory
    // cards used to enter as `status='draft'` and would have been missing
    // from /due. After the gate was removed (commit 35d0e87), they enter
    // as `active` and should be returned alongside vocab.
    await seedActiveVocab('one')
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
    expect(body.cards.map((c) => c.type).sort()).toEqual(['theory', 'vocab'])
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

  test('applyReview returns null for an archived card', async () => {
    const id = await seedActiveVocab('archive-me')
    await conn!.db
      .update(cards)
      .set({ status: 'archived' })
      .where(eq(cards.id, id))
    const result = await applyReview(conn!.db, fsrs, id, RATING.Good, NOW)
    expect(result).toBeNull()
  })

  test('theory cards from ingest enter the active queue immediately', async () => {
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
    const rows = await conn!.db.select().from(cards).where(eq(cards.type, 'theory'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('active')
  })

  test('manually archived card disappears from /due', async () => {
    const id = await seedActiveVocab('hide-me')
    await conn!.db
      .update(cards)
      .set({ status: 'archived' })
      .where(eq(cards.id, id))
    const due = await buildApp().request('/due', { headers: await authHeader() })
    const body = (await due.json()) as { cards: unknown[] }
    expect(body.cards).toHaveLength(0)
  })
})

describe.skipIf(noDb)('GET / (list)', () => {
  test('returns 401 without a JWT', async () => {
    const res = await buildApp().request('/')
    expect(res.status).toBe(401)
  })

  test('defaults to active cards, newest-first, with total', async () => {
    await seedActiveVocab('alpha')
    await seedActiveVocab('beta')
    await seedActiveVocab('gamma')
    const res = await buildApp().request('/', { headers: await authHeader() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      cards: Array<{ payload: { term: string }; status: string }>
      total: number
    }
    expect(body.total).toBe(3)
    expect(body.cards).toHaveLength(3)
    expect(body.cards.every((c) => c.status === 'active')).toBe(true)
    // Newest-first ordering: gamma was inserted last
    expect(body.cards[0]!.payload.term).toBe('gamma')
  })

  test('filters by type=vocab vs type=theory', async () => {
    await seedActiveVocab('one')
    await ingestCards(
      conn!.db,
      fsrs,
      {
        cards: [{ type: 'theory', payload: { question: 'q', answer: 'a' }, source_quote: 'q' }],
      },
      NOW,
    )
    const vocab = await buildApp().request('/?type=vocab', { headers: await authHeader() })
    const theory = await buildApp().request('/?type=theory', { headers: await authHeader() })
    const vocabBody = (await vocab.json()) as { total: number }
    const theoryBody = (await theory.json()) as { total: number }
    expect(vocabBody.total).toBe(1)
    expect(theoryBody.total).toBe(1)
  })

  test('status=archived filter returns archived cards', async () => {
    const id = await seedActiveVocab('to-archive')
    await conn!.db
      .update(cards)
      .set({ status: 'archived' })
      .where(eq(cards.id, id))
    const archived = await buildApp().request('/?status=archived', { headers: await authHeader() })
    const active = await buildApp().request('/', { headers: await authHeader() })
    const archivedBody = (await archived.json()) as { total: number }
    const activeBody = (await active.json()) as { total: number }
    expect(archivedBody.total).toBe(1)
    expect(activeBody.total).toBe(0)
  })

  test('?q=... filters by term substring, case-insensitive', async () => {
    await seedActiveVocab('Spool')
    await seedActiveVocab('Wire')
    await seedActiveVocab('to latch onto')
    const res = await buildApp().request('/?q=SPO', { headers: await authHeader() })
    const body = (await res.json()) as { cards: Array<{ payload: { term: string } }> }
    expect(body.cards).toHaveLength(1)
    expect(body.cards[0]!.payload.term).toBe('Spool')
  })

  test('?limit + ?offset paginate', async () => {
    for (const t of ['a', 'b', 'c', 'd', 'e']) await seedActiveVocab(t)
    const page1 = await buildApp().request('/?limit=2&offset=0', { headers: await authHeader() })
    const page2 = await buildApp().request('/?limit=2&offset=2', { headers: await authHeader() })
    const body1 = (await page1.json()) as { cards: unknown[]; total: number }
    const body2 = (await page2.json()) as { cards: unknown[]; total: number }
    expect(body1.cards).toHaveLength(2)
    expect(body2.cards).toHaveLength(2)
    expect(body1.total).toBe(5)
    expect(body2.total).toBe(5)
  })
})

describe.skipIf(noDb)('POST /:id/archive', () => {
  test('flips an active card to archived', async () => {
    const id = await seedActiveVocab('archive-test')
    const res = await buildApp().request(`/${id}/archive`, {
      method: 'POST',
      headers: await authHeader(),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'archived' })

    const [row] = await conn!.db.select().from(cards).where(eq(cards.id, id))
    expect(row!.status).toBe('archived')

    // Disappears from /due
    const due = await buildApp().request('/due', { headers: await authHeader() })
    const body = (await due.json()) as { cards: unknown[] }
    expect(body.cards).toHaveLength(0)
  })

  test('returns 400 when archiving an already-archived card', async () => {
    const id = await seedActiveVocab('twice')
    await buildApp().request(`/${id}/archive`, {
      method: 'POST',
      headers: await authHeader(),
    })
    const res = await buildApp().request(`/${id}/archive`, {
      method: 'POST',
      headers: await authHeader(),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'not_active' })
  })

  test('returns 404 for unknown id', async () => {
    const res = await buildApp().request('/00000000-0000-0000-0000-000000000000/archive', {
      method: 'POST',
      headers: await authHeader(),
    })
    expect(res.status).toBe(404)
  })

  test('returns 400 for malformed id', async () => {
    const res = await buildApp().request('/not-a-uuid/archive', {
      method: 'POST',
      headers: await authHeader(),
    })
    expect(res.status).toBe(400)
  })
})
