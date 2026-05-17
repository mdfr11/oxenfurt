import { Hono } from 'hono'
import { and, asc, count, desc, eq, lte, or, sql } from 'drizzle-orm'
import * as v from 'valibot'
import {
  CardUpdateInputSchema,
  FsrsService,
  RatingSchema,
  type CardListDto,
  type CardUpdateInput,
  type DueCardDto,
  type FsrsCardState,
  type PhrasePayload,
  type Rating,
  type TheoryPayload,
  type VocabPayload,
} from '@oxenfurt/shared'
import type { Db } from '../db/client.ts'
import { cardReviews, cards, type CardRow } from '../db/schema.ts'
import { jwtAuth } from '../middleware/auth.ts'
import { isUuid } from '../lib/uuid.ts'

export interface CardsRouterDeps {
  db: Db
  jwtSecret: string
  fsrs: FsrsService
  now?: () => Date
}

export function createCardsRouter(deps: CardsRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use('*', jwtAuth({ jwtSecret: deps.jwtSecret, now }))

  // List + filter + search for the Library screen. Defaults to active cards
  // sorted newest-first. The `q` query parameter does case-insensitive
  // contains-match against vocab term/translation and theory question.
  app.get('/', async (c) => {
    const statusRaw = c.req.query('status') ?? 'active'
    const status: 'active' | 'archived' | 'draft' =
      statusRaw === 'archived' ? 'archived'
        : statusRaw === 'draft' ? 'draft'
        : 'active'
    const typeRaw = c.req.query('type')
    const typeFilter: 'vocab' | 'theory' | 'phrase' | undefined =
      typeRaw === 'vocab' || typeRaw === 'theory' || typeRaw === 'phrase' ? typeRaw : undefined
    const q = (c.req.query('q') ?? '').trim()
    const limit = Math.max(1, Math.min(200, Number.parseInt(c.req.query('limit') ?? '50', 10) || 50))
    const offset = Math.max(0, Number.parseInt(c.req.query('offset') ?? '0', 10) || 0)

    // `source` filter for the Library's "By lesson" drill-down. The literal
    // value `__none__` is a sentinel for the "no source" bucket (Postgres
    // doesn't make NULL filterable via query string).
    const sourceRaw = c.req.query('source')
    const conditions = [eq(cards.status, status)]
    if (typeFilter) conditions.push(eq(cards.type, typeFilter))
    if (sourceRaw === '__none__') {
      conditions.push(sql`source IS NULL`)
    } else if (typeof sourceRaw === 'string' && sourceRaw.length > 0) {
      conditions.push(eq(cards.source, sourceRaw))
    }
    if (q.length > 0) {
      const pattern = `%${q.toLowerCase()}%`
      const searchClause = or(
        sql`lower(payload->>'term') LIKE ${pattern}`,
        sql`lower(payload->>'phrase') LIKE ${pattern}`,
        sql`lower(payload->>'translation') LIKE ${pattern}`,
        sql`lower(payload->>'question') LIKE ${pattern}`,
      )!
      conditions.push(searchClause)
    }

    const where = and(...conditions)
    const [rows, totalRow] = await Promise.all([
      deps.db
        .select()
        .from(cards)
        .where(where)
        .orderBy(desc(cards.createdAt))
        .limit(limit)
        .offset(offset),
      deps.db.select({ value: count() }).from(cards).where(where),
    ])
    const total = totalRow[0]?.value ?? 0
    return c.json({ cards: rows.map(toListDto), total })
  })

  // Distinct list of sources with per-source card counts, for the Library's
  // "By lesson" view. Sorted newest first (max card created_at per source).
  // Cards with no source land in a synthetic "Без источника" bucket so the
  // user can still find them.
  app.get('/sources', async (c) => {
    const statusRaw = c.req.query('status') ?? 'active'
    const status: 'active' | 'archived' | 'draft' =
      statusRaw === 'archived' ? 'archived'
        : statusRaw === 'draft' ? 'draft'
        : 'active'

    const rows = await deps.db.execute<{
      source: string | null
      total: number
      vocab_count: number
      phrase_count: number
      theory_count: number
      // postgres-js usually hands timestamptz back as a Date but some
      // driver configurations / CI environments return it as a string.
      // Tolerated below.
      latest: Date | string
    }>(sql`
      SELECT
        source,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE type = 'vocab')::int AS vocab_count,
        COUNT(*) FILTER (WHERE type = 'phrase')::int AS phrase_count,
        COUNT(*) FILTER (WHERE type = 'theory')::int AS theory_count,
        MAX(created_at) AS latest
      FROM ${cards}
      WHERE status = ${status}
      GROUP BY source
      ORDER BY latest DESC NULLS LAST
    `)

    return c.json({
      sources: rows.map((r) => ({
        source: r.source,
        total: r.total,
        vocab_count: r.vocab_count,
        phrase_count: r.phrase_count,
        theory_count: r.theory_count,
        latest:
          r.latest instanceof Date ? r.latest.toISOString() : String(r.latest),
      })),
    })
  })

  app.get('/due', async (c) => {
    const limitRaw = c.req.query('limit') ?? '20'
    const limit = Math.max(1, Math.min(100, Number.parseInt(limitRaw, 10) || 20))
    // bypass_due=true → return all active cards regardless of FSRS schedule.
    // The "I want to drill anyway" escape hatch for when the user blew
    // through the queue but still has appetite. FSRS state updates on
    // review just the same — early-reviewed cards get rescheduled.
    const bypassDue = c.req.query('bypass_due') === 'true'

    const condition = bypassDue
      ? eq(cards.status, 'active')
      : and(eq(cards.status, 'active'), lte(cards.due, now()))

    const rows = await deps.db
      .select()
      .from(cards)
      .where(condition)
      .orderBy(asc(cards.due))
      .limit(limit)

    return c.json({ cards: rows.map(toDueDto) })
  })

  // Related cards from the same `source` (lesson). Used on the back of a
  // card to give the user a quick view of what else came from the same
  // lesson — turns isolated atoms into connected sets. Excludes the
  // anchor card itself; returns active cards only, newest first.
  app.get('/:id/related', async (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json({ error: 'invalid_id' }, 400)
    const [anchor] = await deps.db.select().from(cards).where(eq(cards.id, id))
    if (anchor === undefined) return c.json({ error: 'not_found' }, 404)
    if (anchor.source === null) return c.json({ cards: [] })

    const rows = await deps.db
      .select()
      .from(cards)
      .where(
        and(
          eq(cards.source, anchor.source),
          eq(cards.status, 'active'),
          // exclude self
          sql`id <> ${id}`,
        ),
      )
      .orderBy(desc(cards.createdAt))
      .limit(20)

    return c.json({ cards: rows.map(toListDto) })
  })

  // Inline edit. Updates only the human-editable fields of the payload —
  // FSRS state, source, status, etc. all stay untouched. For vocab cards
  // the term offsets are recomputed server-side so the client doesn't have
  // to track them when the user edits the term or context.
  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json({ error: 'invalid_id' }, 400)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    }
    const parsed = v.safeParse(CardUpdateInputSchema, body)
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', issues: parsed.issues }, 400)
    }

    const result = await updateCardPayload(deps.db, id, parsed.output)
    if (result === 'not_found') return c.json({ error: 'not_found' }, 404)
    if (result === 'type_mismatch') return c.json({ error: 'type_mismatch' }, 400)
    return c.json({ card: toListDto(result) })
  })

  // Archive an active card — soft delete that hides it from /due and from
  // the default Library filter. Idempotency: only `active → archived` is
  // permitted; archiving a draft or already-archived card returns 400.
  app.post('/:id/archive', async (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json({ error: 'invalid_id' }, 400)
    const result = await archiveCard(deps.db, id)
    if (result === 'not_found') return c.json({ error: 'not_found' }, 404)
    if (result === 'not_active') return c.json({ error: 'not_active' }, 400)
    return c.json({ status: 'archived' })
  })

  app.post('/:id/review', async (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) {
      return c.json({ error: 'invalid_id' }, 400)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    }
    const parsed = v.safeParse(v.object({ rating: RatingSchema }), body)
    if (!parsed.success) {
      return c.json({ error: 'invalid_rating' }, 400)
    }

    const reviewedAt = now()
    const updated = await applyReview(deps.db, deps.fsrs, id, parsed.output.rating, reviewedAt)
    if (updated === null) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json({ fsrs: updated })
  })

  return app
}

export async function applyReview(
  db: Db,
  fsrs: FsrsService,
  cardId: string,
  rating: Rating,
  reviewedAt: Date,
): Promise<FsrsCardState | null> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(cards)
      .where(eq(cards.id, cardId))
      .for('update')
    if (row === undefined || row.status !== 'active') return null

    const before: FsrsCardState = {
      fsrs_state: row.fsrsState as FsrsCardState['fsrs_state'],
      due: row.due.toISOString(),
      stability: row.stability,
      difficulty: row.difficulty,
      elapsed_days: row.elapsedDays,
      scheduled_days: row.scheduledDays,
      learning_steps: row.learningSteps,
      reps: row.reps,
      lapses: row.lapses,
      last_review: row.lastReview === null ? null : row.lastReview.toISOString(),
    }

    const { next } = fsrs.applyRating(before, rating, reviewedAt)

    await tx
      .update(cards)
      .set({
        fsrsState: next.fsrs_state,
        due: new Date(next.due),
        stability: next.stability,
        difficulty: next.difficulty,
        elapsedDays: next.elapsed_days,
        scheduledDays: next.scheduled_days,
        learningSteps: next.learning_steps,
        reps: next.reps,
        lapses: next.lapses,
        lastReview: next.last_review === null ? null : new Date(next.last_review),
      })
      .where(eq(cards.id, cardId))

    await tx.insert(cardReviews).values({
      cardId,
      reviewedAt,
      rating,
      fsrsStateBefore: before.fsrs_state,
      fsrsStateAfter: next.fsrs_state,
      stabilityAfter: next.stability,
      difficultyAfter: next.difficulty,
      elapsedDays: next.elapsed_days,
      scheduledDays: next.scheduled_days,
    })

    return next
  })
}

export async function updateCardPayload(
  db: Db,
  cardId: string,
  input: CardUpdateInput,
): Promise<CardRow | 'not_found' | 'type_mismatch'> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(cards)
      .where(eq(cards.id, cardId))
      .for('update')
    if (row === undefined) return 'not_found'
    if (row.type !== input.type) return 'type_mismatch'

    let nextPayload: VocabPayload | TheoryPayload | PhrasePayload
    if (input.type === 'vocab') {
      // Recompute term offsets from the (possibly edited) term and sentence.
      // Case-insensitive search so the user can write "Pragmatic" / sentence
      // "...a pragmatic approach..." and it still matches. If the term isn't
      // a substring of the sentence, fall back to (0, term.length) — cloze
      // gracefully degrades, the user still sees the answer on reveal.
      const { term, translation, context_sentence } = input.payload
      const lowerSentence = context_sentence.toLowerCase()
      const lowerTerm = term.toLowerCase()
      const startIdx = lowerSentence.indexOf(lowerTerm)
      const context_term_start = startIdx >= 0 ? startIdx : 0
      const context_term_end =
        startIdx >= 0 ? startIdx + term.length : term.length
      nextPayload = { term, translation, context_sentence, context_term_start, context_term_end }
    } else if (input.type === 'phrase') {
      // Phrase payload has no derived fields — passthrough.
      nextPayload = { ...input.payload }
    } else {
      nextPayload = { ...input.payload }
    }

    const [updated] = await tx
      .update(cards)
      .set({ payload: nextPayload })
      .where(eq(cards.id, cardId))
      .returning()
    return updated ?? 'not_found'
  })
}

export async function archiveCard(
  db: Db,
  cardId: string,
): Promise<'ok' | 'not_found' | 'not_active'> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(cards)
      .where(eq(cards.id, cardId))
      .for('update')
    if (row === undefined) return 'not_found'
    if (row.status !== 'active') return 'not_active'
    await tx.update(cards).set({ status: 'archived' }).where(eq(cards.id, cardId))
    return 'ok'
  })
}

function toListDto(row: CardRow): CardListDto {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    payload: row.payload,
    source: row.source,
    source_quote: row.sourceQuote,
    created_at: row.createdAt.toISOString(),
    due: row.due.toISOString(),
    reps: row.reps,
    lapses: row.lapses,
  }
}

function toDueDto(row: CardRow): DueCardDto {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    source: row.source,
    source_quote: row.sourceQuote,
    fsrs: {
      fsrs_state: row.fsrsState as FsrsCardState['fsrs_state'],
      due: row.due.toISOString(),
      stability: row.stability,
      difficulty: row.difficulty,
      elapsed_days: row.elapsedDays,
      scheduled_days: row.scheduledDays,
      learning_steps: row.learningSteps,
      reps: row.reps,
      lapses: row.lapses,
      last_review: row.lastReview === null ? null : row.lastReview.toISOString(),
    },
  }
}

