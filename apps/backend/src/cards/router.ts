import { Hono } from 'hono'
import { and, asc, eq, lte } from 'drizzle-orm'
import * as v from 'valibot'
import {
  FsrsService,
  RatingSchema,
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

  app.get('/due', async (c) => {
    const limitRaw = c.req.query('limit') ?? '20'
    const limit = Math.max(1, Math.min(100, Number.parseInt(limitRaw, 10) || 20))

    const rows = await deps.db
      .select()
      .from(cards)
      .where(and(eq(cards.status, 'active'), lte(cards.due, now())))
      .orderBy(asc(cards.due))
      .limit(limit)

    return c.json({ cards: rows.map(toDueDto) })
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
