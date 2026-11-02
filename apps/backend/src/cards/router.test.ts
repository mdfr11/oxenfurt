import { beforeEach, describe, expect, test } from 'bun:test'
import { and, asc, eq } from 'drizzle-orm'
import { FsrsService, RATING } from '@oxenfurt/shared'
import { signSession } from '../auth/jwt.ts'
import { getTestDb, resetTestDb } from '../db/testing.ts'
import { assignmentItems, assignments, cardReviews, cards } from '../db/schema.ts'
import { ingestCards } from '../ingest/cards.ts'
import { settleActiveAssignment } from '../assignments/service.ts'
import { applyReview, createCardsRouter } from './router.ts'

const conn = await getTestDb()
const noDb = conn === null

const JWT_SECRET = '0123456789abcdef0123456789abcdef-test'
const INGEST_TOKEN = 'test-ingest-token'
const NOW = new Date('2026-01-01T12:00:00.000Z')
const fsrs = new FsrsService({ enableFuzz: false })

const buildApp = () =>
  createCardsRouter({
    db: conn!.db,
    jwtSecret: JWT_SECRET,
    ingestToken: INGEST_TOKEN,
    fsrs,
    now: () => NOW,
  })

async function authHeader(userId = 99): Promise<{ authorization: string }> {
  const token = await signSession({ userId }, JWT_SECRET, { ttlSeconds: 900, now: NOW })
  return { authorization: `Bearer ${token}` }
}

async function seedActiveVocab(term: string, dueAt: Date = NOW, source?: string): Promise<string> {
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
          ...(source ? { source } : {}),
        },
      ],
    },
    dueAt,
  )
  const rows = await conn!.db.select().from(cards)
  return rows.find((r) => (r.payload as { term: string }).term === term)!.id
}

async function seedActivePhrase(phrase: string, dueAt: Date = NOW, source?: string): Promise<string> {
  await ingestCards(
    conn!.db,
    fsrs,
    {
      cards: [
        {
          type: 'phrase',
          payload: {
            phrase,
            translation: 'тест',
            context_sentence: `Try to ${phrase} every day.`,
          },
          ...(source ? { source } : {}),
        },
      ],
    },
    dueAt,
  )
  const rows = await conn!.db.select().from(cards)
  return rows.find((r) => (r.payload as { phrase?: string }).phrase === phrase)!.id
}

async function seedActiveTheory(question: string, source?: string): Promise<string> {
  await ingestCards(
    conn!.db,
    fsrs,
    {
      cards: [
        {
          type: 'theory',
          payload: { question, answer: 'answer body' },
          source_quote: 'q',
          ...(source ? { source } : {}),
        },
      ],
    },
    NOW,
  )
  const rows = await conn!.db.select().from(cards)
  return rows.find((r) => (r.payload as { question?: string }).question === question)!.id
}

// Mirrors `seedCards` from assignments/router.test.ts — seeds `count` active
// vocab cards and returns their ids, for tests that only care about having
// a handful of cards, not their content.
async function seedManyCards(count: number): Promise<string[]> {
  await ingestCards(
    conn!.db,
    fsrs,
    {
      cards: Array.from({ length: count }, (_, i) => ({
        type: 'vocab' as const,
        payload: {
          term: `many${i}`,
          translation: `перевод${i}`,
          context_sentence: `A sentence with many${i} inside.`,
          context_term_start: 14,
          context_term_end: 14 + `many${i}`.length,
        },
      })),
    },
    NOW,
  )
  const rows = await conn!.db.select({ id: cards.id }).from(cards).orderBy(asc(cards.createdAt))
  return rows.map((r) => r.id)
}

async function reviewRequest(id: string, body: Record<string, unknown>) {
  return buildApp().request(`/${id}/review`, {
    method: 'POST',
    headers: { ...(await authHeader()), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
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

  test('returns the entire due queue without an explicit limit, including more than 100 cards', async () => {
    const ids = await seedManyCards(125)
    const futureId = await seedActiveVocab('future', new Date(NOW.getTime() + 86_400_000))
    const archivedId = await seedActiveVocab('archived')
    await conn!.db.update(cards).set({ status: 'archived' }).where(eq(cards.id, archivedId))
    const oldestId = ids[0]!
    await conn!.db.update(cards).set({ due: new Date(NOW.getTime() - 86_400_000) }).where(eq(cards.id, oldestId))

    const res = await buildApp().request('/due', { headers: await authHeader() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cards: Array<{ id: string }> }
    expect(body.cards).toHaveLength(ids.length)
    expect(new Set(body.cards.map((card) => card.id))).toEqual(new Set(ids))
    expect(body.cards[0]!.id).toBe(oldestId)
    expect(body.cards.some((card) => card.id === futureId || card.id === archivedId)).toBe(false)
  })

  test('limited sessions can exhaust the due queue without replaying completed cards', async () => {
    const ids = await seedManyCards(25)
    const seen = new Set<string>()
    const app = buildApp()
    const headers = await authHeader()

    for (const expectedCount of [10, 10, 5, 0]) {
      const res = await app.request('/due?limit=10', { headers })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { cards: Array<{ id: string }> }
      expect(body.cards).toHaveLength(expectedCount)
      for (const card of body.cards) {
        expect(seen.has(card.id)).toBe(false)
        seen.add(card.id)
        const review = await reviewRequest(card.id, { rating: RATING.Easy })
        expect(review.status).toBe(200)
      }
    }

    expect(seen).toEqual(new Set(ids))
  })

  test('?type=vocab returns only vocab cards', async () => {
    await seedActiveVocab('alpha', new Date(NOW.getTime() - 3000))
    await seedActivePhrase('on the other hand', new Date(NOW.getTime() - 2000))
    await seedActiveTheory('When to use *in case*?')
    const res = await buildApp().request('/due?type=vocab', { headers: await authHeader() })
    const body = (await res.json()) as { cards: Array<{ type: string }> }
    expect(body.cards.every((c) => c.type === 'vocab')).toBe(true)
    expect(body.cards).toHaveLength(1)
  })

  test('?type=theory returns only theory cards', async () => {
    await seedActiveVocab('alpha', new Date(NOW.getTime() - 3000))
    await seedActivePhrase('by the way', new Date(NOW.getTime() - 2000))
    await seedActiveTheory('Difference between A and B?')
    const res = await buildApp().request('/due?type=theory', { headers: await authHeader() })
    const body = (await res.json()) as { cards: Array<{ type: string }> }
    expect(body.cards).toHaveLength(1)
    expect(body.cards[0]!.type).toBe('theory')
  })

  test('?type=phrase returns only phrase cards', async () => {
    await seedActiveVocab('alpha', new Date(NOW.getTime() - 3000))
    await seedActivePhrase('over the moon', new Date(NOW.getTime() - 2000))
    await seedActiveTheory('Q?')
    const res = await buildApp().request('/due?type=phrase', { headers: await authHeader() })
    const body = (await res.json()) as { cards: Array<{ type: string }> }
    expect(body.cards).toHaveLength(1)
    expect(body.cards[0]!.type).toBe('phrase')
  })

  test('unknown ?type value is silently ignored (no 400, returns all)', async () => {
    await seedActiveVocab('alpha', new Date(NOW.getTime() - 3000))
    await seedActivePhrase('the X factor', new Date(NOW.getTime() - 2000))
    const res = await buildApp().request('/due?type=garbage', { headers: await authHeader() })
    expect(res.status).toBe(200)
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

  test("applyReview returns 'not_found' for an archived card", async () => {
    const id = await seedActiveVocab('archive-me')
    await conn!.db
      .update(cards)
      .set({ status: 'archived' })
      .where(eq(cards.id, id))
    const result = await applyReview(conn!.db, fsrs, id, RATING.Good, NOW)
    expect(result).toBe('not_found')
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

describe.skipIf(noDb)('POST /cards/:id/review — drill and assignment completion', () => {
  async function seedActiveAssignment(cardIds: string[]) {
    const [row] = await conn!.db
      .insert(assignments)
      .values({ title: 'Задание', dueAt: new Date('2026-08-06T21:00:00.000Z') })
      .returning()
    await conn!.db.insert(assignmentItems).values(
      cardIds.map((cardId, i) => ({
        assignmentId: row!.id,
        cardId,
        groupLabel: 'Тема',
        groupKind: 'topic' as const,
        position: i,
      })),
    )
    return row!.id
  }

  test('rating Good completes the matching assignment item', async () => {
    const ids = await seedManyCards(3)
    await seedActiveAssignment(ids)

    const res = await reviewRequest(ids[0]!, { rating: 3 })
    expect(res.status).toBe(200)

    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt).not.toBeNull()
  })

  test('rating Again leaves the item unfinished', async () => {
    const ids = await seedManyCards(3)
    await seedActiveAssignment(ids)

    await reviewRequest(ids[0]!, { rating: 1 })

    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt).toBeNull()
  })

  test('rating Hard leaves the item unfinished', async () => {
    const ids = await seedManyCards(3)
    await seedActiveAssignment(ids)

    await reviewRequest(ids[0]!, { rating: 2 })

    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt).toBeNull()
  })

  // Lazy expiry has to run on the WRITE path too, not just the reads. It's
  // the only surface where a rating could otherwise land on an assignment
  // whose deadline had already passed — stamping an item, and with the last
  // one settling the whole thing as `completed` after the fact.
  test('a review past the deadline expires the assignment and stamps nothing', async () => {
    const ids = await seedManyCards(3)
    const [row] = await conn!.db
      .insert(assignments)
      .values({ title: 'Просроченное', dueAt: new Date('2025-12-31T12:00:00.000Z') })
      .returning()
    await conn!.db.insert(assignmentItems).values(
      ids.map((cardId, i) => ({
        assignmentId: row!.id,
        cardId,
        groupLabel: 'Тема',
        groupKind: 'topic' as const,
        position: i,
      })),
    )

    const res = await reviewRequest(ids[0]!, { rating: 3 })
    expect(res.status).toBe(200)

    const [after] = await conn!.db.select().from(assignments).where(eq(assignments.id, row!.id))
    expect(after!.status).toBe('expired')
    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt).toBeNull()
  })

  test('an expired assignment cannot be settled by rating its last card', async () => {
    const ids = await seedManyCards(1)
    const [row] = await conn!.db
      .insert(assignments)
      .values({ title: 'Просроченное', dueAt: new Date('2025-12-31T12:00:00.000Z') })
      .returning()
    await conn!.db.insert(assignmentItems).values({
      assignmentId: row!.id,
      cardId: ids[0]!,
      groupLabel: 'Тема',
      groupKind: 'topic' as const,
      position: 0,
    })

    await reviewRequest(ids[0]!, { rating: 4 })

    const [after] = await conn!.db.select().from(assignments).where(eq(assignments.id, row!.id))
    expect(after!.status).toBe('expired')
    expect(after!.completedAt).toBeNull()
  })

  test('a review before the deadline still completes the item', async () => {
    // The other side of the expiry guard: it must not touch a live one.
    const ids = await seedManyCards(3)
    const assignmentId = await seedActiveAssignment(ids)

    await reviewRequest(ids[0]!, { rating: 3 })

    const [after] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(after!.status).toBe('active')
    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt).not.toBeNull()
  })

  test('drill:true does not touch FSRS state or card_reviews', async () => {
    const ids = await seedManyCards(3)
    await seedActiveAssignment(ids)
    const [before] = await conn!.db.select().from(cards).where(eq(cards.id, ids[0]!))

    const res = await reviewRequest(ids[0]!, { rating: 3, drill: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ fsrs: null, drill: true })

    const [after] = await conn!.db.select().from(cards).where(eq(cards.id, ids[0]!))
    expect(after!.reps).toBe(before!.reps)
    expect(after!.due.toISOString()).toBe(before!.due.toISOString())
    const reviews = await conn!.db.select().from(cardReviews)
    expect(reviews).toHaveLength(0)
  })

  test('drill:true still completes the assignment item', async () => {
    const ids = await seedManyCards(3)
    await seedActiveAssignment(ids)

    await reviewRequest(ids[0]!, { rating: 3, drill: true })

    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt).not.toBeNull()
  })

  test('drill:true on a nonexistent card returns 404 and stamps no assignment item', async () => {
    const ids = await seedManyCards(3)
    await seedActiveAssignment(ids)
    const ghost = '99999999-9999-4999-8999-999999999999'

    const res = await reviewRequest(ghost, { rating: 3, drill: true })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })

    const items = await conn!.db.select().from(assignmentItems)
    expect(items.every((i) => i.completedAt === null)).toBe(true)
  })

  test('drill:true on an archived card returns 404 and stamps no assignment item', async () => {
    const ids = await seedManyCards(3)
    await seedActiveAssignment(ids)
    await conn!.db.update(cards).set({ status: 'archived' }).where(eq(cards.id, ids[0]!))

    const res = await reviewRequest(ids[0]!, { rating: 3, drill: true })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })

    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt).toBeNull()
  })

  test('drill:false still writes FSRS state and a review row', async () => {
    const ids = await seedManyCards(3)
    const [before] = await conn!.db.select().from(cards).where(eq(cards.id, ids[0]!))

    await reviewRequest(ids[0]!, { rating: 3 })

    const [after] = await conn!.db.select().from(cards).where(eq(cards.id, ids[0]!))
    expect(after!.reps).toBe(before!.reps + 1)
    const reviews = await conn!.db.select().from(cardReviews)
    expect(reviews).toHaveLength(1)
  })

  test('completing the last item flips the assignment to completed', async () => {
    const ids = await seedManyCards(3)
    const assignmentId = await seedActiveAssignment(ids)

    for (const id of ids) await reviewRequest(id, { rating: 3 })

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('completed')
  })

  // Regression for a live-QA bug: the undo-window flush fires the last two
  // reviews of a session within milliseconds of each other. Each ran
  // settleActiveAssignment's "remaining" check against a snapshot that
  // didn't yet include the other's uncommitted stamp, so both saw one item
  // outstanding and neither settled — the assignment finished (all items
  // stamped) but stayed 'active' forever, stranding the Home screen and
  // blocking new assignments with 409. Fired with Promise.all rather than
  // sequential awaits so the two requests genuinely overlap as concurrent
  // transactions, not just two fast sequential ones.
  test('concurrent completion of the last two items still settles the assignment', async () => {
    const ids = await seedManyCards(3)
    const assignmentId = await seedActiveAssignment(ids)
    await reviewRequest(ids[0]!, { rating: 3 })

    const [a, b] = await Promise.all([
      reviewRequest(ids[1]!, { rating: 3 }),
      reviewRequest(ids[2]!, { rating: 3 }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('completed')
    expect(row!.completedAt).not.toBeNull()
  })

  // The Promise.all test above exercises the real endpoint, but on a local
  // loopback DB the two requests can each finish well inside the other's
  // connection setup, so it doesn't reliably force the interleave that
  // caused the bug — confirmed by running it against the unpatched service
  // (no lock): 0 failures in 5 reruns, a false green. This test forces the
  // exact window instead of hoping for it: two transactions each stamp
  // their own item, then rendezvous on a barrier so BOTH stamps are
  // guaranteed uncommitted before EITHER calls settleActiveAssignment —
  // the precise interleave observed in production (two reviews 3ms apart).
  // Without the FOR UPDATE lock, each side's "remaining" read misses the
  // other's uncommitted stamp and neither settles, deterministically.
  test('two transactions racing to settle via a forced interleave both still land on completed', async () => {
    const ids = await seedManyCards(3)
    const assignmentId = await seedActiveAssignment(ids)
    await reviewRequest(ids[0]!, { rating: 3 })

    let markAStamped: () => void = () => {}
    let markBStamped: () => void = () => {}
    const aStamped = new Promise<void>((resolve) => { markAStamped = resolve })
    const bStamped = new Promise<void>((resolve) => { markBStamped = resolve })

    async function stampThenSettle(cardId: string, markSelfStamped: () => void, waitForOther: Promise<void>) {
      await conn!.db.transaction(async (tx) => {
        await tx
          .update(assignmentItems)
          .set({ completedAt: NOW })
          .where(
            and(eq(assignmentItems.assignmentId, assignmentId), eq(assignmentItems.cardId, cardId)),
          )
        markSelfStamped()
        await waitForOther
        await settleActiveAssignment(tx, NOW)
      })
    }

    await Promise.all([
      stampThenSettle(ids[1]!, markAStamped, bStamped),
      stampThenSettle(ids[2]!, markBStamped, aStamped),
    ])

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('completed')
    expect(row!.completedAt).not.toBeNull()
  })

  test('archiving the last unfinished card completes the assignment', async () => {
    const ids = await seedManyCards(3)
    const assignmentId = await seedActiveAssignment(ids)
    await reviewRequest(ids[0]!, { rating: 3 })
    await reviewRequest(ids[1]!, { rating: 3 })

    const res = await buildApp().request(`/${ids[2]}/archive`, {
      method: 'POST',
      headers: await authHeader(),
    })
    expect(res.status).toBe(200)

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('completed')
    expect(row!.completedAt).not.toBeNull()
  })

  test('archiving a card while others are unfinished leaves the assignment active', async () => {
    const ids = await seedManyCards(3)
    const assignmentId = await seedActiveAssignment(ids)

    await buildApp().request(`/${ids[2]}/archive`, {
      method: 'POST',
      headers: await authHeader(),
    })

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('active')
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

// ---------------------------------------------------------------------------
// PATCH /:id — inline edit. Verifies the contract from the EditCardSheet:
//   - vocab: client sends only term/translation/context_sentence; server
//     recomputes context_term_start/end from the new term + sentence.
//   - theory: passthrough of question/answer.
//   - phrase: passthrough of phrase/translation/context/optional pattern.
//   - type mismatch (vocab payload for a theory card) is rejected.
// ---------------------------------------------------------------------------
describe.skipIf(noDb)('PATCH /:id (inline edit)', () => {
  test('returns 401 without a JWT', async () => {
    const res = await buildApp().request('/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'vocab', payload: { term: 'x', translation: 'x', context_sentence: 'x' } }),
    })
    expect(res.status).toBe(401)
  })

  test('returns 400 for non-UUID id', async () => {
    const res = await buildApp().request('/not-a-uuid', {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'vocab', payload: { term: 'a', translation: 'b', context_sentence: 'c' } }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_id' })
  })

  test('returns 400 for unparseable JSON body', async () => {
    const id = await seedActiveVocab('foo')
    const res = await buildApp().request(`/${id}`, {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: '{not-json',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_body' })
  })

  test('returns 400 for schema-invalid payload (empty term)', async () => {
    const id = await seedActiveVocab('emptyish')
    const res = await buildApp().request(`/${id}`, {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'vocab', payload: { term: '', translation: 'x', context_sentence: 'x' } }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_payload')
  })

  test('returns 404 for unknown card id', async () => {
    const res = await buildApp().request('/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'vocab', payload: { term: 'x', translation: 'x', context_sentence: 'x' } }),
    })
    expect(res.status).toBe(404)
  })

  test('returns 400 type_mismatch when sending wrong-type payload', async () => {
    const id = await seedActiveVocab('iam-vocab')
    const res = await buildApp().request(`/${id}`, {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'theory', payload: { question: 'q', answer: 'a' } }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'type_mismatch' })
  })

  test('vocab: updates fields and recomputes offsets from the new term', async () => {
    const id = await seedActiveVocab('pragmatic')
    const res = await buildApp().request(`/${id}`, {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'vocab',
        payload: {
          term: 'versatile',
          translation: 'универсальный',
          context_sentence: 'She is a versatile musician.',
        },
      }),
    })
    expect(res.status).toBe(200)
    const [row] = await conn!.db.select().from(cards).where(eq(cards.id, id))
    const p = row!.payload as { term: string; translation: string; context_sentence: string; context_term_start: number; context_term_end: number }
    expect(p.term).toBe('versatile')
    expect(p.translation).toBe('универсальный')
    // 'versatile' starts at index 9 in 'She is a versatile musician.'
    // ("She is a " is 9 chars including the trailing space).
    expect(p.context_term_start).toBe(9)
    expect(p.context_term_end).toBe(9 + 'versatile'.length)
  })

  test('vocab: offset recompute is case-insensitive', async () => {
    const id = await seedActiveVocab('original')
    await buildApp().request(`/${id}`, {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'vocab',
        payload: { term: 'Pragmatic', translation: 'x', context_sentence: 'A pragmatic choice indeed.' },
      }),
    })
    const [row] = await conn!.db.select().from(cards).where(eq(cards.id, id))
    const p = row!.payload as { context_term_start: number; context_term_end: number }
    // 'pragmatic' is at index 2 (after "A ")
    expect(p.context_term_start).toBe(2)
    expect(p.context_term_end).toBe(2 + 'Pragmatic'.length)
  })

  test('vocab: accepts empty context_sentence and zeroes the offsets', async () => {
    const id = await seedActiveVocab('hasSentence')
    const res = await buildApp().request(`/${id}`, {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'vocab',
        payload: { term: 'orphan', translation: 'сирота', context_sentence: '' },
      }),
    })
    expect(res.status).toBe(200)
    const [row] = await conn!.db.select().from(cards).where(eq(cards.id, id))
    const p = row!.payload as { context_sentence: string; context_term_start: number; context_term_end: number }
    expect(p.context_sentence).toBe('')
    expect(p.context_term_start).toBe(0)
    expect(p.context_term_end).toBe(0)
  })

  test('phrase: accepts empty context_sentence', async () => {
    const id = await seedActivePhrase('on the go')
    const res = await buildApp().request(`/${id}`, {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'phrase',
        payload: { phrase: 'on the go', translation: 'на бегу', context_sentence: '' },
      }),
    })
    expect(res.status).toBe(200)
    const [row] = await conn!.db.select().from(cards).where(eq(cards.id, id))
    const p = row!.payload as { context_sentence: string }
    expect(p.context_sentence).toBe('')
  })

  test('vocab: falls back to (0, term.length) when term is not in the sentence', async () => {
    const id = await seedActiveVocab('searchme')
    await buildApp().request(`/${id}`, {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'vocab',
        payload: { term: 'absent', translation: 'отсутствующий', context_sentence: 'No such word here.' },
      }),
    })
    const [row] = await conn!.db.select().from(cards).where(eq(cards.id, id))
    const p = row!.payload as { context_term_start: number; context_term_end: number }
    expect(p.context_term_start).toBe(0)
    expect(p.context_term_end).toBe('absent'.length)
  })

  test('vocab: does NOT touch FSRS state', async () => {
    const id = await seedActiveVocab('keepstate')
    // First put the card through one review so its FSRS state changes.
    await applyReview(conn!.db, fsrs, id, RATING.Good, NOW)
    const [before] = await conn!.db.select().from(cards).where(eq(cards.id, id))

    await buildApp().request(`/${id}`, {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'vocab',
        payload: { term: 'renamed', translation: 'x', context_sentence: 'renamed is now the term' },
      }),
    })

    const [after] = await conn!.db.select().from(cards).where(eq(cards.id, id))
    expect(after!.fsrsState).toBe(before!.fsrsState)
    expect(after!.stability).toBe(before!.stability)
    expect(after!.due.getTime()).toBe(before!.due.getTime())
    expect(after!.reps).toBe(before!.reps)
  })

  test('theory: updates question and answer', async () => {
    const id = await seedActiveTheory('Old question')
    await buildApp().request(`/${id}`, {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'theory',
        payload: { question: 'New question', answer: 'New **answer**' },
      }),
    })
    const [row] = await conn!.db.select().from(cards).where(eq(cards.id, id))
    const p = row!.payload as { question: string; answer: string }
    expect(p.question).toBe('New question')
    expect(p.answer).toBe('New **answer**')
  })

  test('phrase: passes through fields without offset recompute', async () => {
    const id = await seedActivePhrase('take into account')
    await buildApp().request(`/${id}`, {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'phrase',
        payload: {
          phrase: 'pay attention to',
          translation: 'обращать внимание на',
          context_sentence: 'Please pay attention to the details.',
          pattern: 'to pay attention to {sth}',
        },
      }),
    })
    const [row] = await conn!.db.select().from(cards).where(eq(cards.id, id))
    const p = row!.payload as { phrase: string; translation: string; pattern?: string }
    expect(p.phrase).toBe('pay attention to')
    expect(p.translation).toBe('обращать внимание на')
    expect(p.pattern).toBe('to pay attention to {sth}')
    // No offset fields injected for phrase.
    expect((row!.payload as Record<string, unknown>).context_term_start).toBeUndefined()
  })

  test('phrase: optional pattern can be omitted', async () => {
    const id = await seedActivePhrase('on the other hand')
    const res = await buildApp().request(`/${id}`, {
      method: 'PATCH',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'phrase',
        payload: {
          phrase: 'by the way',
          translation: 'между прочим',
          context_sentence: 'By the way, where is he?',
        },
      }),
    })
    expect(res.status).toBe(200)
    const [row] = await conn!.db.select().from(cards).where(eq(cards.id, id))
    const p = row!.payload as { pattern?: string }
    expect(p.pattern).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// GET /sources — Library "By lesson" picker.
// ---------------------------------------------------------------------------
describe.skipIf(noDb)('GET /sources', () => {
  test('returns 401 without a JWT', async () => {
    const res = await buildApp().request('/sources')
    expect(res.status).toBe(401)
  })

  test('returns an empty list when there are no cards', async () => {
    const res = await buildApp().request('/sources', { headers: await authHeader() })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sources: [] })
  })

  test('groups cards by source with per-type counts', async () => {
    await seedActiveVocab('alpha', NOW, 'lesson-A')
    await seedActiveVocab('beta', NOW, 'lesson-A')
    await seedActivePhrase('on the go', NOW, 'lesson-A')
    await seedActiveTheory('rule one', 'lesson-B')
    const res = await buildApp().request('/sources', { headers: await authHeader() })
    const body = (await res.json()) as {
      sources: Array<{ source: string | null; total: number; vocab_count: number; theory_count: number }>
    }
    const a = body.sources.find((s) => s.source === 'lesson-A')!
    const b = body.sources.find((s) => s.source === 'lesson-B')!
    expect(a.total).toBe(3)
    expect(a.vocab_count).toBe(2)
    expect(b.total).toBe(1)
    expect(b.theory_count).toBe(1)
  })

  test('cards without a source land in the null bucket', async () => {
    await seedActiveVocab('sourceless')
    const res = await buildApp().request('/sources', { headers: await authHeader() })
    const body = (await res.json()) as { sources: Array<{ source: string | null; total: number }> }
    expect(body.sources).toHaveLength(1)
    expect(body.sources[0]!.source).toBeNull()
    expect(body.sources[0]!.total).toBe(1)
  })

  test('respects ?status filter (archived cards excluded by default)', async () => {
    const id = await seedActiveVocab('to-archive', NOW, 'lesson-X')
    await conn!.db.update(cards).set({ status: 'archived' }).where(eq(cards.id, id))
    const active = await buildApp().request('/sources', { headers: await authHeader() })
    const archived = await buildApp().request('/sources?status=archived', { headers: await authHeader() })
    const activeBody = (await active.json()) as { sources: unknown[] }
    const archivedBody = (await archived.json()) as { sources: Array<{ source: string | null; total: number }> }
    expect(activeBody.sources).toHaveLength(0)
    expect(archivedBody.sources).toHaveLength(1)
    expect(archivedBody.sources[0]!.total).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Extra coverage for GET / — phrase filter, source filter, search across
// phrase field.
// ---------------------------------------------------------------------------
describe.skipIf(noDb)('GET / extras (phrase + source filters)', () => {
  test('filters by type=phrase', async () => {
    await seedActiveVocab('plain')
    await seedActivePhrase('a multi word phrase')
    const res = await buildApp().request('/?type=phrase', { headers: await authHeader() })
    const body = (await res.json()) as { cards: Array<{ type: string }>; total: number }
    expect(body.total).toBe(1)
    expect(body.cards[0]!.type).toBe('phrase')
  })

  test('?source= filters to one lesson', async () => {
    await seedActiveVocab('x', NOW, 'lesson-A')
    await seedActiveVocab('y', NOW, 'lesson-B')
    const res = await buildApp().request('/?source=lesson-A', { headers: await authHeader() })
    const body = (await res.json()) as { cards: Array<{ source: string | null }>; total: number }
    expect(body.total).toBe(1)
    expect(body.cards[0]!.source).toBe('lesson-A')
  })

  test('?source=__none__ filters to cards with no source', async () => {
    await seedActiveVocab('with-src', NOW, 'lesson-A')
    await seedActiveVocab('no-src')
    const res = await buildApp().request('/?source=__none__', { headers: await authHeader() })
    const body = (await res.json()) as { cards: Array<{ source: string | null }>; total: number }
    expect(body.total).toBe(1)
    expect(body.cards[0]!.source).toBeNull()
  })

  test('search ?q= matches inside phrase field', async () => {
    await seedActivePhrase('take into account')
    await seedActivePhrase('pay attention to')
    const res = await buildApp().request('/?q=account', { headers: await authHeader() })
    const body = (await res.json()) as { cards: Array<{ payload: { phrase?: string } }>; total: number }
    expect(body.total).toBe(1)
    expect(body.cards[0]!.payload.phrase).toBe('take into account')
  })

  test('combines type=phrase + source filter', async () => {
    await seedActiveVocab('vocab-A', NOW, 'lesson-A')
    await seedActivePhrase('phrase from A', NOW, 'lesson-A')
    await seedActivePhrase('phrase from B', NOW, 'lesson-B')
    const res = await buildApp().request('/?type=phrase&source=lesson-A', {
      headers: await authHeader(),
    })
    const body = (await res.json()) as { cards: Array<{ payload: { phrase?: string } }>; total: number }
    expect(body.total).toBe(1)
    expect(body.cards[0]!.payload.phrase).toBe('phrase from A')
  })
})

// ---------------------------------------------------------------------------
// /due — phrase cards behave like vocab.
// ---------------------------------------------------------------------------
describe.skipIf(noDb)('GET /due with phrase cards', () => {
  test('phrase cards appear in /due alongside vocab', async () => {
    await seedActiveVocab('single')
    await seedActivePhrase('multi word here')
    const res = await buildApp().request('/due', { headers: await authHeader() })
    const body = (await res.json()) as { cards: Array<{ type: string }> }
    expect(body.cards.map((c) => c.type).sort()).toEqual(['phrase', 'vocab'])
  })

  test('phrase cards respect FSRS due date — future-due ones are hidden', async () => {
    await seedActivePhrase('not due yet', new Date(NOW.getTime() + 24 * 3600 * 1000))
    const res = await buildApp().request('/due', { headers: await authHeader() })
    const body = (await res.json()) as { cards: unknown[] }
    expect(body.cards).toHaveLength(0)
  })

  test('bypass_due=true exposes phrase cards even when scheduled far ahead', async () => {
    await seedActivePhrase('much later', new Date(NOW.getTime() + 30 * 24 * 3600 * 1000))
    const res = await buildApp().request('/due?bypass_due=true', { headers: await authHeader() })
    const body = (await res.json()) as { cards: unknown[] }
    expect(body.cards).toHaveLength(1)
  })
})
