import { Hono } from 'hono'
import { and, asc, count, desc, eq, inArray, lte, or, sql } from 'drizzle-orm'
import * as v from 'valibot'
import {
  CardUpdateInputSchema,
  FsrsService,
  RatingSchema,
  type CardListDto,
  type CardUpdateInput,
  type FsrsCardState,
  type PhrasePayload,
  type Rating,
  type TheoryPayload,
  type VocabPayload,
} from '@oxenfurt/shared'
import type { Db } from '../db/client.ts'
import type { ScopeRow } from '../db/schema.ts'
import { cardQuestions, cardReviews, cards, type CardRow } from '../db/schema.ts'
import {
  expireStaleAssignments,
  markCardCompleted,
  settleActiveAssignment,
} from '../assignments/service.ts'
import { dualAuth, type ScopeRef } from '../middleware/scope.ts'
import { isUuid } from '../lib/uuid.ts'
import { toDueDto } from './dto.ts'

export interface CardsRouterDeps {
  db: Db
  jwtSecret: string
  tokenScopes: ReadonlyMap<string, ScopeRef>
  scopes: ScopeRow[]
  fsrs: FsrsService
  now?: () => Date
}

async function fetchQuestionsMap(db: Db, cardIds: string[]): Promise<Set<string>> {
  if (cardIds.length === 0) return new Set()
  // Count questions that are not discarded
  const rows = await db
    .selectDistinct({ cardId: cardQuestions.cardId })
    .from(cardQuestions)
    .where(
      and(
        inArray(cardQuestions.cardId, cardIds),
        sql`status <> 'discarded'`
      )
    )
  return new Set(rows.map(r => r.cardId))
}

export function createCardsRouter(deps: CardsRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use(
    '*',
    dualAuth({
      tokenScopes: deps.tokenScopes,
      jwtSecret: deps.jwtSecret,
      scopes: deps.scopes,
      now,
    }),
  )

  // List + filter + search for the Library screen. Defaults to active cards
  // sorted newest-first. The `q` query parameter does case-insensitive
  // contains-match against vocab term/translation and theory question.
  app.get('/', async (c) => {
    const scope = c.get('scope')
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
    const conditions = [eq(cards.scopeId, scope.id), eq(cards.status, status)]
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
    const questionsSet = await fetchQuestionsMap(deps.db, rows.map(r => r.id))
    return c.json({ cards: rows.map(r => toListDto(r, questionsSet.has(r.id))), total })
  })

  // Distinct list of sources with per-source card counts, for the Library's
  // "By lesson" view. Sorted newest first (max card created_at per source).
  // Cards with no source land in a synthetic "Без источника" bucket so the
  // user can still find them.
  app.get('/sources', async (c) => {
    const scope = c.get('scope')
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
      WHERE scope_id = ${scope.id} AND status = ${status}
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
    const scope = c.get('scope')
    // No limit means the full due queue (the session-size setting "All").
    // Only cap sessions when the caller explicitly requests a size.
    const limitRaw = c.req.query('limit')
    const limit = limitRaw === undefined
      ? undefined
      : Math.max(1, Math.min(100, Number.parseInt(limitRaw, 10) || 20))
    // bypass_due=true → return all active cards regardless of FSRS schedule.
    // The "I want to drill anyway" escape hatch for when the user blew
    // through the queue but still has appetite. FSRS state updates on
    // review just the same — early-reviewed cards get rescheduled.
    const bypassDue = c.req.query('bypass_due') === 'true'
    // Optional type filter for focused sessions — "only theory",
    // "only vocab", etc. Unknown values are silently ignored so a
    // stale client value doesn't crash the request.
    const typeRaw = c.req.query('type')
    const typeFilter: 'vocab' | 'theory' | 'phrase' | undefined =
      typeRaw === 'vocab' || typeRaw === 'theory' || typeRaw === 'phrase' ? typeRaw : undefined

    const conds = [eq(cards.scopeId, scope.id), eq(cards.status, 'active')]
    if (!bypassDue) conds.push(lte(cards.due, now()))
    if (typeFilter !== undefined) conds.push(eq(cards.type, typeFilter))
    const condition = and(...conds)

    const query = deps.db
      .select()
      .from(cards)
      .where(condition)
      .orderBy(asc(cards.due))
    const rows = await (limit === undefined ? query : query.limit(limit))

    const questionsSet = await fetchQuestionsMap(deps.db, rows.map(r => r.id))
    return c.json({ cards: rows.map(r => toDueDto(r, questionsSet.has(r.id))) })
  })

  // Related cards from the same `source` (lesson). Used on the back of a
  // card to give the user a quick view of what else came from the same
  // lesson — turns isolated atoms into connected sets. Excludes the
  // anchor card itself; returns active cards only, newest first.
  app.get('/:id/related', async (c) => {
    const scope = c.get('scope')
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json({ error: 'invalid_id' }, 400)
    const [anchor] = await deps.db
      .select()
      .from(cards)
      .where(and(eq(cards.id, id), eq(cards.scopeId, scope.id)))
    if (anchor === undefined) return c.json({ error: 'not_found' }, 404)
    if (anchor.source === null) return c.json({ cards: [] })

    const rows = await deps.db
      .select()
      .from(cards)
      .where(
        and(
          eq(cards.scopeId, scope.id),
          eq(cards.source, anchor.source),
          eq(cards.status, 'active'),
          // exclude self
          sql`id <> ${id}`,
        ),
      )
      .orderBy(desc(cards.createdAt))
      .limit(20)

    const questionsSet = await fetchQuestionsMap(deps.db, rows.map(r => r.id))
    return c.json({ cards: rows.map(r => toListDto(r, questionsSet.has(r.id))) })
  })

  // Inline edit. Updates only the human-editable fields of the payload —
  // FSRS state, source, status, etc. all stay untouched. For vocab cards
  // the term offsets are recomputed server-side so the client doesn't have
  // to track them when the user edits the term or context.
  app.patch('/:id', async (c) => {
    const scope = c.get('scope')
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

    const result = await updateCardPayload(deps.db, id, parsed.output, scope.id)
    if (result === 'not_found') return c.json({ error: 'not_found' }, 404)
    if (result === 'type_mismatch') return c.json({ error: 'type_mismatch' }, 400)
    
    const questionsSet = await fetchQuestionsMap(deps.db, [id])
    return c.json({ card: toListDto(result, questionsSet.has(id)) })
  })

  // Archive an active card — soft delete that hides it from /due and from
  // the default Library filter. Idempotency: only `active → archived` is
  // permitted; archiving a draft or already-archived card returns 400.
  app.post('/:id/archive', async (c) => {
    const scope = c.get('scope')
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json({ error: 'invalid_id' }, 400)
    const result = await archiveCard(deps.db, id, scope.id, now())
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
    const parsed = v.safeParse(
      v.object({ rating: RatingSchema, drill: v.optional(v.boolean(), false) }),
      body,
    )
    if (!parsed.success) {
      return c.json({ error: 'invalid_rating' }, 400)
    }

    const reviewedAt = now()
    const drill = parsed.output.drill
    const result = await applyReview(
      deps.db,
      deps.fsrs,
      id,
      parsed.output.rating,
      reviewedAt,
      {
        drill,
        scopeId: c.get('scope').id,
      },
    )
    if (result === 'not_found') return c.json({ error: 'not_found' }, 404)
    if (result === 'drilled') return c.json({ fsrs: null, drill: true })
    return c.json({ fsrs: result, drill })
  })

  return app
}

export interface ApplyReviewOptions {
  /** Repeat of a card already measured today. Moves assignment progress
   *  but writes nothing to FSRS — cramming is study, not measurement.
   *  This is scoped to assignments, not a global correction: a same-day
   *  repeat after a failed answer is exactly what FSRS learning steps
   *  model, so free practice's second write is legitimate and stays
   *  unflagged. In an assignment the learner may take one card four or
   *  five times in a sitting to clear it, and only the first of those is
   *  an honest measurement. */
  drill?: boolean
  /** The scope the request came through. A card from another scope is
   *  not_found here, not 500 — a stale client that switched scopes must
   *  not reach across decks. */
  scopeId?: string
}

export async function applyReview(
  db: Db,
  fsrs: FsrsService,
  cardId: string,
  rating: Rating,
  reviewedAt: Date,
  opts: ApplyReviewOptions = {},
): Promise<FsrsCardState | 'not_found' | 'drilled'> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(cards)
      .where(
        opts.scopeId === undefined
          ? eq(cards.id, cardId)
          : and(eq(cards.id, cardId), eq(cards.scopeId, opts.scopeId)),
      )
      .for('update')
    if (row === undefined || row.status !== 'active') return 'not_found'

    // Lazy expiry, same as every read path. Without it this was the one
    // surface where an assignment past its deadline could still have items
    // stamped — and, with the last one, be settled as `completed`. Runs
    // after the card lock so the order stays card-then-assignment.
    await expireStaleAssignments(tx, reviewedAt)

    if (rating >= 3) {
      // The card's own scope owns the assignment slot it can complete —
      // reviewing an english card must never settle the go assignment.
      await markCardCompleted(tx, row.scopeId, cardId, reviewedAt)
    }

    if (opts.drill === true) return 'drilled'

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
  scopeId?: string,
): Promise<CardRow | 'not_found' | 'type_mismatch'> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(cards)
      .where(
        scopeId === undefined
          ? eq(cards.id, cardId)
          : and(eq(cards.id, cardId), eq(cards.scopeId, scopeId)),
      )
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
      //
      // Empty sentence is a valid edit (the cabinet allows clearing it).
      // In that case offsets are zeroed — practice surfaces degrade to the
      // no-sentence path (cloze → recognition, no quote block).
      const { term, translation, context_sentence } = input.payload
      let context_term_start = 0
      let context_term_end = 0
      if (context_sentence.length > 0) {
        const startIdx = context_sentence.toLowerCase().indexOf(term.toLowerCase())
        context_term_start = startIdx >= 0 ? startIdx : 0
        context_term_end = startIdx >= 0 ? startIdx + term.length : term.length
      }
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
  scopeId: string,
  now: Date,
): Promise<'ok' | 'not_found' | 'not_active'> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(cards)
      .where(and(eq(cards.id, cardId), eq(cards.scopeId, scopeId)))
      .for('update')
    if (row === undefined) return 'not_found'
    if (row.status !== 'active') return 'not_active'
    await tx.update(cards).set({ status: 'archived' }).where(eq(cards.id, cardId))
    // Same transaction as the archive itself — if settlement throws, the
    // archive rolls back too, so a retry never lands on a stuck 400
    // not_active with the assignment left stranded active.
    await settleActiveAssignment(tx, row.scopeId, now)
    return 'ok'
  })
}

function toListDto(row: CardRow, hasQuestions?: boolean): CardListDto {
  const dto: CardListDto = {
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
  if (hasQuestions) dto.has_questions = true
  return dto
}

