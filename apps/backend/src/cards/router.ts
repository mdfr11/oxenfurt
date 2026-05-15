import { Hono } from 'hono'
import { and, asc, count, desc, eq, lte, or, sql } from 'drizzle-orm'
import * as v from 'valibot'
import {
  FsrsService,
  RatingSchema,
  type CardListDto,
  type DueCardDto,
  type FsrsCardState,
  type Rating,
} from '@oxenfurt/shared'
import type { Db } from '../db/client.ts'
import { cardReviews, cards, type CardRow } from '../db/schema.ts'
import { jwtAuth } from '../middleware/auth.ts'

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
    const typeFilter: 'vocab' | 'theory' | undefined =
      typeRaw === 'vocab' || typeRaw === 'theory' ? typeRaw : undefined
    const q = (c.req.query('q') ?? '').trim()
    const limit = Math.max(1, Math.min(200, Number.parseInt(c.req.query('limit') ?? '50', 10) || 50))
    const offset = Math.max(0, Number.parseInt(c.req.query('offset') ?? '0', 10) || 0)

    const conditions = [eq(cards.status, status)]
    if (typeFilter) conditions.push(eq(cards.type, typeFilter))
    if (q.length > 0) {
      const pattern = `%${q.toLowerCase()}%`
      const searchClause = or(
        sql`lower(payload->>'term') LIKE ${pattern}`,
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}
