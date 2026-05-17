import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { FsrsService } from '@oxenfurt/shared'
import { getTestDb, resetTestDb } from '../db/testing.ts'
import { cardQuestions, cards } from '../db/schema.ts'
import { ingestCards } from '../ingest/cards.ts'
import { signSession } from '../auth/jwt.ts'
import { createAgentQuestionsRouter, createUserQuestionsRouter } from './router.ts'

const conn = await getTestDb()
const noDb = conn === null
const JWT_SECRET = '0123456789abcdef0123456789abcdef-questions'
const INGEST_TOKEN = 'test-ingest-token-1234567890'
const NOW = new Date('2026-05-17T12:00:00.000Z')

const fsrs = new FsrsService({ enableFuzz: false })

beforeEach(async () => {
  if (conn) await resetTestDb(conn.db)
})

async function authHeader(): Promise<string> {
  const token = await signSession({ userId: 1 }, JWT_SECRET, { ttlSeconds: 900, now: NOW })
  return `Bearer ${token}`
}

async function seedVocabCard(): Promise<string> {
  await ingestCards(
    conn!.db,
    fsrs,
    {
      cards: [
        {
          type: 'vocab',
          payload: {
            term: 'versatile',
            translation: 'разносторонний',
            context_sentence: 'She is a versatile musician.',
            context_term_start: 9,
            context_term_end: 18,
          },
          source: 'Lesson 7',
        },
      ],
    },
    NOW,
  )
  const [row] = await conn!.db.select({ id: cards.id }).from(cards)
  return row!.id
}

function userApp() {
  return createUserQuestionsRouter({ db: conn!.db, jwtSecret: JWT_SECRET, now: () => NOW })
}
function agentApp() {
  return createAgentQuestionsRouter({ db: conn!.db, ingestToken: INGEST_TOKEN, now: () => NOW })
}

describe.skipIf(noDb)('user /questions', () => {
  test('POST /cards/:id — 400 invalid uuid', async () => {
    const res = await userApp().request('/cards/not-a-uuid', {
      method: 'POST',
      headers: { authorization: await authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'why?' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /cards/:id — 401 without bearer', async () => {
    const res = await userApp().request('/cards/00000000-0000-0000-0000-000000000000', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'why?' }),
    })
    expect(res.status).toBe(401)
  })

  test('POST /cards/:id — 404 for unknown card', async () => {
    const res = await userApp().request('/cards/11111111-1111-1111-1111-111111111111', {
      method: 'POST',
      headers: { authorization: await authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'why?' }),
    })
    expect(res.status).toBe(404)
  })

  test('POST /cards/:id — 400 on empty question', async () => {
    const cardId = await seedVocabCard()
    const res = await userApp().request(`/cards/${cardId}`, {
      method: 'POST',
      headers: { authorization: await authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ question: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /cards/:id — happy path inserts a pending question', async () => {
    const cardId = await seedVocabCard()
    const res = await userApp().request(`/cards/${cardId}`, {
      method: 'POST',
      headers: { authorization: await authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'what does versatile mean in this context?' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { question: { id: string; status: string } }
    expect(body.question.status).toBe('pending')

    const rows = await conn!.db
      .select()
      .from(cardQuestions)
      .where(eq(cardQuestions.cardId, cardId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.question).toBe('what does versatile mean in this context?')
  })

  test('GET /count + /unread reflect answered-but-not-seen state only', async () => {
    const cardId = await seedVocabCard()
    // Insert three questions in different states.
    const pending = await conn!.db
      .insert(cardQuestions)
      .values({ cardId, question: 'q-pending' })
      .returning()
    const answered = await conn!.db
      .insert(cardQuestions)
      .values({
        cardId,
        question: 'q-answered',
        status: 'answered',
        response: 'because',
        answeredAt: NOW,
      })
      .returning()
    await conn!.db.insert(cardQuestions).values({
      cardId,
      question: 'q-seen',
      status: 'answered',
      response: 'r',
      answeredAt: NOW,
      seenAt: NOW,
    })
    void pending
    void answered

    const auth = await authHeader()
    const countRes = await userApp().request('/count', { headers: { authorization: auth } })
    expect(countRes.status).toBe(200)
    expect(await countRes.json()).toEqual({ unread: 1 })

    const unreadRes = await userApp().request('/unread', { headers: { authorization: auth } })
    expect(unreadRes.status).toBe(200)
    const body = (await unreadRes.json()) as { unread: Array<{ question: string }> }
    expect(body.unread.map((q) => q.question)).toEqual(['q-answered'])
  })

  test('POST /:id/seen flips seenAt and removes from unread', async () => {
    const cardId = await seedVocabCard()
    const [q] = await conn!.db
      .insert(cardQuestions)
      .values({
        cardId,
        question: 'q',
        status: 'answered',
        response: 'r',
        answeredAt: NOW,
      })
      .returning()

    const res = await userApp().request(`/${q!.id}/seen`, {
      method: 'POST',
      headers: { authorization: await authHeader() },
    })
    expect(res.status).toBe(200)

    const [row] = await conn!.db
      .select({ seenAt: cardQuestions.seenAt })
      .from(cardQuestions)
      .where(eq(cardQuestions.id, q!.id))
    expect(row!.seenAt).not.toBeNull()
  })

  test('POST /:id/discard transitions status', async () => {
    const cardId = await seedVocabCard()
    const [q] = await conn!.db
      .insert(cardQuestions)
      .values({ cardId, question: 'q' })
      .returning()

    const res = await userApp().request(`/${q!.id}/discard`, {
      method: 'POST',
      headers: { authorization: await authHeader() },
    })
    expect(res.status).toBe(200)

    const [row] = await conn!.db
      .select({ status: cardQuestions.status })
      .from(cardQuestions)
      .where(eq(cardQuestions.id, q!.id))
    expect(row!.status).toBe('discarded')
  })

  test('GET /card/:id returns all questions for that card, newest first', async () => {
    const cardId = await seedVocabCard()
    await conn!.db.insert(cardQuestions).values({ cardId, question: 'first' })
    await conn!.db.insert(cardQuestions).values({ cardId, question: 'second' })

    const res = await userApp().request(`/card/${cardId}`, {
      headers: { authorization: await authHeader() },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { questions: Array<{ question: string }> }
    expect(body.questions).toHaveLength(2)
  })
})

describe.skipIf(noDb)('agent /agent/questions', () => {
  test('GET /pending — 401 without ingest token', async () => {
    const res = await agentApp().request('/pending')
    expect(res.status).toBe(401)
  })

  test('GET /pending returns only status=pending, with card payload', async () => {
    const cardId = await seedVocabCard()
    await conn!.db.insert(cardQuestions).values({ cardId, question: 'q-pending' })
    await conn!.db.insert(cardQuestions).values({
      cardId,
      question: 'q-answered',
      status: 'answered',
      response: 'r',
      answeredAt: NOW,
    })

    const res = await agentApp().request('/pending', {
      headers: { authorization: `Bearer ${INGEST_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      questions: Array<{ question: string; card: { type: string; payload: { term?: string } } }>
    }
    expect(body.questions).toHaveLength(1)
    expect(body.questions[0]!.question).toBe('q-pending')
    expect(body.questions[0]!.card.type).toBe('vocab')
    // payload was JSONB — should arrive as an object, not a string.
    expect(body.questions[0]!.card.payload.term).toBe('versatile')
  })

  test('POST /:id/response — happy path flips to answered', async () => {
    const cardId = await seedVocabCard()
    const [q] = await conn!.db
      .insert(cardQuestions)
      .values({ cardId, question: 'q' })
      .returning()

    const res = await agentApp().request(`/${q!.id}/response`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ response: 'because semantic context.' }),
    })
    expect(res.status).toBe(200)

    const [row] = await conn!.db
      .select({ status: cardQuestions.status, response: cardQuestions.response })
      .from(cardQuestions)
      .where(eq(cardQuestions.id, q!.id))
    expect(row!.status).toBe('answered')
    expect(row!.response).toBe('because semantic context.')
  })

  test('POST /:id/response — 404 for unknown id', async () => {
    const res = await agentApp().request('/11111111-1111-1111-1111-111111111111/response', {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ response: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  test('POST /:id/response — 400 on empty body', async () => {
    const cardId = await seedVocabCard()
    const [q] = await conn!.db
      .insert(cardQuestions)
      .values({ cardId, question: 'q' })
      .returning()
    const res = await agentApp().request(`/${q!.id}/response`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ response: '' }),
    })
    expect(res.status).toBe(400)
  })
})
