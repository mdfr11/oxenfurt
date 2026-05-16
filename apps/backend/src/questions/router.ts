// Notes-on-cards pipeline. Two HTTP surfaces:
//
//  1. User-facing routes under /questions, gated by JWT auth.
//     Lets the Mini App post a note from a card, list answered ones,
//     mark them seen, and discard.
//
//  2. Agent-facing routes under /agent/questions, gated by the same
//     bearer ingest token Hermes already uses. Hermes polls /pending,
//     processes (LLM call with lesson context), and posts back to
//     /:id/response. New related cards can be added via the existing
//     ingest path — we don't try to bundle them here.

import { Hono } from 'hono'
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm'
import * as v from 'valibot'
import type { Db } from '../db/client.ts'
import { cardQuestions, cards } from '../db/schema.ts'
import { ingestTokenAuth } from '../middleware/ingest-token.ts'
import { jwtAuth } from '../middleware/auth.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}

// Routers ------------------------------------------------------------------

export interface UserRouterDeps {
  db: Db
  jwtSecret: string
  now?: () => Date
}

const PostQuestionSchema = v.object({
  question: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
})

export function createUserQuestionsRouter(deps: UserRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())
  app.use('*', jwtAuth({ jwtSecret: deps.jwtSecret, now }))

  // POST /cards/:cardId — create a new question against a specific card.
  // Mounted under /cards/:cardId to keep the URL grammar honest.
  app.post('/cards/:cardId', async (c) => {
    const cardId = c.req.param('cardId')
    if (!isUuid(cardId)) return c.json({ error: 'invalid_id' }, 400)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    }
    const parsed = v.safeParse(PostQuestionSchema, body)
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', issues: parsed.issues }, 400)
    }

    const [card] = await deps.db.select({ id: cards.id }).from(cards).where(eq(cards.id, cardId))
    if (card === undefined) return c.json({ error: 'not_found' }, 404)

    const [row] = await deps.db
      .insert(cardQuestions)
      .values({ cardId, question: parsed.output.question })
      .returning()
    return c.json({ question: rowToDto(row!) })
  })

  // GET /unread — count + list of answered-but-not-seen questions.
  // Used for the Home badge.
  app.get('/unread', async (c) => {
    const rows = await deps.db
      .select()
      .from(cardQuestions)
      .where(and(eq(cardQuestions.status, 'answered'), isNull(cardQuestions.seenAt)))
      .orderBy(desc(cardQuestions.answeredAt))
      .limit(50)
    return c.json({ unread: rows.map(rowToDto) })
  })

  // GET /count — just the unread number (cheap, polled by the badge).
  app.get('/count', async (c) => {
    const [row] = await deps.db
      .select({ value: count() })
      .from(cardQuestions)
      .where(and(eq(cardQuestions.status, 'answered'), isNull(cardQuestions.seenAt)))
    return c.json({ unread: row?.value ?? 0 })
  })

  // GET /card/:cardId — all questions tied to one card (any status), newest first.
  app.get('/card/:cardId', async (c) => {
    const cardId = c.req.param('cardId')
    if (!isUuid(cardId)) return c.json({ error: 'invalid_id' }, 400)
    const rows = await deps.db
      .select()
      .from(cardQuestions)
      .where(eq(cardQuestions.cardId, cardId))
      .orderBy(desc(cardQuestions.createdAt))
    return c.json({ questions: rows.map(rowToDto) })
  })

  // POST /:id/seen — mark a single answered question as read so it stops
  // appearing in the unread badge. Idempotent.
  app.post('/:id/seen', async (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json({ error: 'invalid_id' }, 400)
    await deps.db
      .update(cardQuestions)
      .set({ seenAt: now() })
      .where(and(eq(cardQuestions.id, id), isNull(cardQuestions.seenAt)))
    return c.json({ ok: true })
  })

  // POST /:id/discard — soft delete. Used when the user no longer cares
  // about a pending or answered question. The row stays for audit.
  app.post('/:id/discard', async (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json({ error: 'invalid_id' }, 400)
    await deps.db
      .update(cardQuestions)
      .set({ status: 'discarded' })
      .where(eq(cardQuestions.id, id))
    return c.json({ ok: true })
  })

  return app
}

// ---- Agent (Hermes) router ------------------------------------------------

export interface AgentRouterDeps {
  db: Db
  ingestToken: string
  now?: () => Date
}

const RespondSchema = v.object({
  response: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(10_000)),
})

export function createAgentQuestionsRouter(deps: AgentRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())
  app.use('*', ingestTokenAuth({ ingestToken: deps.ingestToken }))

  // GET /pending — Hermes polls for up-to-50 unanswered questions with
  // the full card payload + source so it can build a rich prompt.
  app.get('/pending', async (c) => {
    const limitRaw = c.req.query('limit') ?? '20'
    const limit = Math.max(1, Math.min(50, Number.parseInt(limitRaw, 10) || 20))
    const rows = await deps.db.execute<{
      question_id: string
      question: string
      created_at: Date
      card_id: string
      card_type: string
      payload: unknown
      source: string | null
      source_quote: string | null
    }>(sql`
      SELECT
        q.id AS question_id,
        q.question,
        q.created_at,
        c.id AS card_id,
        c.type AS card_type,
        c.payload,
        c.source,
        c.source_quote
      FROM card_questions q
      JOIN cards c ON c.id = q.card_id
      WHERE q.status = 'pending'
      ORDER BY q.created_at ASC
      LIMIT ${limit}
    `)
    return c.json({
      questions: rows.map((r) => ({
        question_id: r.question_id,
        question: r.question,
        created_at: r.created_at.toISOString(),
        card: {
          id: r.card_id,
          type: r.card_type,
          payload: r.payload,
          source: r.source,
          source_quote: r.source_quote,
        },
      })),
    })
  })

  // POST /:id/response — Hermes writes back. Flips status to 'answered'
  // and stamps answered_at. Idempotent-ish: a second response just
  // overwrites the previous one.
  app.post('/:id/response', async (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json({ error: 'invalid_id' }, 400)
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    }
    const parsed = v.safeParse(RespondSchema, body)
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', issues: parsed.issues }, 400)
    }
    const result = await deps.db
      .update(cardQuestions)
      .set({
        status: 'answered',
        response: parsed.output.response,
        answeredAt: now(),
      })
      .where(eq(cardQuestions.id, id))
      .returning()
    if (result.length === 0) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true })
  })

  return app
}

// ---- Helpers --------------------------------------------------------------

interface CardQuestionDto {
  id: string
  card_id: string
  question: string
  status: 'pending' | 'answered' | 'discarded'
  response: string | null
  created_at: string
  answered_at: string | null
  seen_at: string | null
}

function rowToDto(row: typeof cardQuestions.$inferSelect): CardQuestionDto {
  return {
    id: row.id,
    card_id: row.cardId,
    question: row.question,
    status: row.status,
    response: row.response,
    created_at: row.createdAt.toISOString(),
    answered_at: row.answeredAt === null ? null : row.answeredAt.toISOString(),
    seen_at: row.seenAt === null ? null : row.seenAt.toISOString(),
  }
}
