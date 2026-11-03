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
import type { ScopeRow } from '../db/schema.ts'
import { cardQuestions, cards } from '../db/schema.ts'
import { ingestScopeAuth } from '../middleware/ingest-token.ts'
import { jwtAuthWithScope, type ScopeRef } from '../middleware/scope.ts'
import { isUuid } from '../lib/uuid.ts'

// Routers ------------------------------------------------------------------

export interface UserRouterDeps {
  db: Db
  jwtSecret: string
  scopes: ScopeRow[]
  now?: () => Date
}

const PostQuestionSchema = v.object({
  question: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
})

export function createUserQuestionsRouter(deps: UserRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())
  app.use(
    '*',
    jwtAuthWithScope({ jwtSecret: deps.jwtSecret, scopes: deps.scopes, now }),
  )

  // POST /cards/:cardId — create a new question against a specific card.
  // Mounted under /cards/:cardId to keep the URL grammar honest.
  app.post('/cards/:cardId', async (c) => {
    const scope = c.get('scope')
    const cardId = c.req.param('cardId')
    if (!isUuid(cardId)) return c.json({ error: 'invalid_id' }, 400)

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    }
    const parsed = v.safeParse(PostQuestionSchema, rawBody)
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', issues: parsed.issues }, 400)
    }

    const [card] = await deps.db
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.id, cardId), eq(cards.scopeId, scope.id)))
    if (card === undefined) return c.json({ error: 'not_found' }, 404)

    const [row] = await deps.db
      .insert(cardQuestions)
      .values({ cardId, question: parsed.output.question })
      .returning()

    return c.json({ question: rowToDto(row!) })
  })

  // GET /unread — count + list of answered-but-not-seen questions.
  // Each entry comes with a small card preview so the AnswersScreen can
  // show "from <card>" without an N+1 chase per row. `title` resolves
  // to the most identifying field per card type — term for vocab,
  // phrase for phrase, question for theory.
  app.get('/unread', async (c) => {
    const scope = c.get('scope')
    const rows = await deps.db.execute<{
      id: string
      card_id: string
      question: string
      status: 'pending' | 'answered' | 'discarded'
      response: string | null
      created_at: Date | string
      answered_at: Date | string | null
      seen_at: Date | string | null
      card_type: 'vocab' | 'theory' | 'phrase'
      card_payload: { term?: string; phrase?: string; question?: string }
      card_source: string | null
    }>(sql`
      SELECT
        q.id, q.card_id, q.question, q.status, q.response,
        q.created_at, q.answered_at, q.seen_at,
        c.type AS card_type,
        c.payload AS card_payload,
        c.source AS card_source
      FROM card_questions q
      JOIN cards c ON c.id = q.card_id
      WHERE q.status = 'answered' AND q.seen_at IS NULL
        AND c.scope_id = ${scope.id}
      ORDER BY q.answered_at DESC
      LIMIT 50
    `)
    return c.json({
      unread: rows.map((r) => ({
        id: r.id,
        card_id: r.card_id,
        question: r.question,
        status: r.status,
        response: r.response,
        created_at: toIsoOrString(r.created_at),
        answered_at: r.answered_at === null ? null : toIsoOrString(r.answered_at),
        seen_at: r.seen_at === null ? null : toIsoOrString(r.seen_at),
        card: {
          id: r.card_id,
          type: r.card_type,
          title:
            r.card_type === 'vocab'
              ? (r.card_payload.term ?? '')
              : r.card_type === 'phrase'
                ? (r.card_payload.phrase ?? '')
                : (r.card_payload.question ?? ''),
          source: r.card_source,
        },
      })),
    })
  })

  // GET /count — just the unread number (cheap, polled by the badge).
  app.get('/count', async (c) => {
    const scope = c.get('scope')
    const [row] = await deps.db
      .select({ value: count() })
      .from(cardQuestions)
      .innerJoin(cards, eq(cards.id, cardQuestions.cardId))
      .where(
        and(
          eq(cardQuestions.status, 'answered'),
          isNull(cardQuestions.seenAt),
          eq(cards.scopeId, scope.id),
        ),
      )
    return c.json({ unread: row?.value ?? 0 })
  })

  // GET /card/:cardId — all questions tied to one card (any status), newest first.
  app.get('/card/:cardId', async (c) => {
    const scope = c.get('scope')
    const cardId = c.req.param('cardId')
    if (!isUuid(cardId)) return c.json({ error: 'invalid_id' }, 400)
    const rows = await deps.db
      .select({ question: cardQuestions })
      .from(cardQuestions)
      .innerJoin(cards, eq(cards.id, cardQuestions.cardId))
      .where(and(eq(cardQuestions.cardId, cardId), eq(cards.scopeId, scope.id)))
      .orderBy(desc(cardQuestions.createdAt))
    return c.json({ questions: rows.map((r) => rowToDto(r.question)) })
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
  tokenScopes: ReadonlyMap<string, ScopeRef>
  now?: () => Date
}

const RespondSchema = v.object({
  response: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(10_000)),
})

export function createAgentQuestionsRouter(deps: AgentRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())
  app.use('*', ingestScopeAuth({ tokens: deps.tokenScopes }))

  // GET /pending — Hermes polls for up-to-50 unanswered questions with
  // the full card payload + source so it can build a rich prompt. Only
  // the agent's OWN scope: the medicine bot never sees english lesson
  // questions.
  app.get('/pending', async (c) => {
    const scope = c.get('scope')
    const limitRaw = c.req.query('limit') ?? '20'
    const limit = Math.max(1, Math.min(50, Number.parseInt(limitRaw, 10) || 20))
    const rows = await deps.db.execute<{
      question_id: string
      question: string
      created_at: Date | string
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
        AND c.scope_id = ${scope.id}
      ORDER BY q.created_at ASC
      LIMIT ${limit}
    `)
    return c.json({
      questions: rows.map((r) => ({
        question_id: r.question_id,
        question: r.question,
        // postgres-js usually hands back timestamptz as Date, but some
        // driver configurations (or compat shims) return it as a string.
        // Tolerate both rather than blowing up with "toISOString is not a
        // function" — Hermes can parse either.
        created_at:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : String(r.created_at),
        card: {
          id: r.card_id,
          type: r.card_type,
          // postgres-js parses JSONB to JS objects by default, so this
          // is already the right shape for Hermes.
          payload: r.payload,
          source: r.source,
          source_quote: r.source_quote,
        },
      })),
    })
  })

  // POST /:id/response — Hermes writes back. Flips status to 'answered'
  // and stamps answered_at. Idempotent-ish: a second response just
  // overwrites the previous one. The scope check rides the same UPDATE:
  // an agent may only answer questions about cards in its own scope.
  app.post('/:id/response', async (c) => {
    const scope = c.get('scope')
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
    const result = await deps.db.execute<{ id: string }>(sql`
      UPDATE card_questions q
      SET status = 'answered',
          response = ${parsed.output.response},
          answered_at = ${now().toISOString()}
      FROM cards c
      WHERE q.card_id = c.id
        AND q.id = ${id}
        AND c.scope_id = ${scope.id}
      RETURNING q.id
    `)
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



function toIsoOrString(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d)
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
