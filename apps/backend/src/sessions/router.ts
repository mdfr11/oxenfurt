import { Hono } from 'hono'
import { desc, eq, isNotNull, sql } from 'drizzle-orm'
import * as v from 'valibot'
import type { StatsResponse } from '@oxenfurt/shared'
import type { Db } from '../db/client.ts'
import { sessions } from '../db/schema.ts'
import { jwtAuth } from '../middleware/auth.ts'
import { isUuid } from '../lib/uuid.ts'

export interface SessionsRouterDeps {
  db: Db
  jwtSecret: string
  now?: () => Date
}

const FinishBodySchema = v.object({
  cards_reviewed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  cards_correct: v.pipe(v.number(), v.integer(), v.minValue(0)),
})

export function createSessionsRouter(deps: SessionsRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use('*', jwtAuth({ jwtSecret: deps.jwtSecret, now }))

  // Aggregated stats — single round-trip for the Stats screen.
  app.get('/stats', async (c) => {
    const stats = await computeStats(deps.db, now())
    return c.json(stats)
  })

  // Start a session. The client is free to ignore the response — if this
  // request fails (e.g. backend down) the practice flow still works locally
  // and just goes untracked.
  app.post('/', async (c) => {
    const [row] = await deps.db
      .insert(sessions)
      .values({ startedAt: now() })
      .returning({ id: sessions.id, startedAt: sessions.startedAt })
    return c.json({
      id: row!.id,
      started_at: row!.startedAt.toISOString(),
    })
  })

  // Finalise a session with the client-computed totals.
  // Once finished, the row is immutable — subsequent /finish returns 400.
  app.post('/:id/finish', async (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json({ error: 'invalid_id' }, 400)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    }
    const parsed = v.safeParse(FinishBodySchema, body)
    if (!parsed.success) return c.json({ error: 'invalid_payload' }, 400)
    if (parsed.output.cards_correct > parsed.output.cards_reviewed) {
      return c.json({ error: 'invalid_payload' }, 400)
    }

    const result = await finishSession(
      deps.db,
      id,
      parsed.output.cards_reviewed,
      parsed.output.cards_correct,
      now(),
    )
    if (result === 'not_found') return c.json({ error: 'not_found' }, 404)
    if (result === 'already_finished') return c.json({ error: 'already_finished' }, 400)
    return c.json({
      id,
      finished_at: result.finishedAt.toISOString(),
      cards_reviewed: parsed.output.cards_reviewed,
      cards_correct: parsed.output.cards_correct,
    })
  })

  return app
}

/**
 * Aggregated stats for the mobile Stats screen. All dates are computed in
 * UTC — clients render in their local zone if they want. Single-user
 * deployments don't need per-user filtering; if/when this becomes
 * multi-tenant, add a userId filter to every WHERE.
 */
export async function computeStats(db: Db, when: Date): Promise<StatsResponse> {
  // Convert dates to epoch ms for SQL interpolation — postgres-js doesn't
  // accept raw JS Date objects in parameterized queries.
  const whenTs = when.getTime()
  const dayStartTs = new Date(when).setUTCHours(0, 0, 0, 0)
  const weekStartTs = whenTs - 7 * 24 * 3600 * 1000
  const monthStartTs = whenTs - 30 * 24 * 3600 * 1000
  const yearStartTs = whenTs - 365 * 24 * 3600 * 1000
  const next24hTs = whenTs + 24 * 3600 * 1000

  // All five queries can run concurrently — no FK or ordering deps between them.
  const [reviewsAgg, sessionsAgg, forecastAgg, heatmapRows, recentRows, learnedAgg, streakRows] = await Promise.all([
    db.execute<{
      today_count: string
      today_correct: string
      week_count: string
      week_correct: string
      month_count: string
      month_correct: string
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE reviewed_at >= to_timestamp(${dayStartTs / 1000}))                                   AS today_count,
        COUNT(*) FILTER (WHERE reviewed_at >= to_timestamp(${dayStartTs / 1000})  AND rating >= 3)                  AS today_correct,
        COUNT(*) FILTER (WHERE reviewed_at >= to_timestamp(${weekStartTs / 1000}))                                  AS week_count,
        COUNT(*) FILTER (WHERE reviewed_at >= to_timestamp(${weekStartTs / 1000}) AND rating >= 3)                  AS week_correct,
        COUNT(*) FILTER (WHERE reviewed_at >= to_timestamp(${monthStartTs / 1000}))                                 AS month_count,
        COUNT(*) FILTER (WHERE reviewed_at >= to_timestamp(${monthStartTs / 1000}) AND rating >= 3)                 AS month_correct
      FROM card_reviews
    `),
    db.execute<{ today_count: string; week_count: string }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE started_at >= to_timestamp(${dayStartTs / 1000}))  AS today_count,
        COUNT(*) FILTER (WHERE started_at >= to_timestamp(${weekStartTs / 1000})) AS week_count
      FROM sessions
    `),
    db.execute<{ due_now: string; due_next_24h: string; active_total: string }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE due <= to_timestamp(${whenTs / 1000}))                                       AS due_now,
        COUNT(*) FILTER (WHERE due >  to_timestamp(${whenTs / 1000}) AND due <= to_timestamp(${next24hTs / 1000}))                 AS due_next_24h,
        COUNT(*)                                                                     AS active_total
      FROM cards
      WHERE status = 'active'
    `),
    db.execute<{ day: string; cnt: string }>(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('day', reviewed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
        COUNT(*)                                                                  AS cnt
      FROM card_reviews
      WHERE reviewed_at >= to_timestamp(${yearStartTs / 1000})
      GROUP BY day
      ORDER BY day
    `),
    db
      .select({
        id: sessions.id,
        startedAt: sessions.startedAt,
        finishedAt: sessions.finishedAt,
        cardsReviewed: sessions.cardsReviewed,
        cardsCorrect: sessions.cardsCorrect,
      })
      .from(sessions)
      .where(isNotNull(sessions.finishedAt))
      .orderBy(desc(sessions.startedAt))
      .limit(10),
    // FSRS state is stored as flat columns on `cards`, not as a JSON column.
    // The earlier `fsrs->>'stability'` reference 500'd at runtime; the same
    // bug was fixed once in stats/router.ts and regressed here.
    db.execute<{ count: string }>(sql`
      SELECT COUNT(*) as count
      FROM cards
      WHERE status = 'active' AND stability >= 10
    `),
    // Bounded streak window. The streak loop stops at the first gap
    // day, so anything older than ~2 months is dead weight; the prior
    // unbounded SELECT DISTINCT scanned the entire card_reviews table.
    // 90 days covers any realistic streak comfortably.
    db.execute<{ review_date: Date | string }>(sql`
      SELECT DISTINCT date_trunc('day', reviewed_at) as review_date
      FROM card_reviews
      WHERE reviewed_at >= to_timestamp(${(whenTs - 90 * 24 * 3600 * 1000) / 1000})
      ORDER BY review_date DESC
    `),
  ])

  const r = reviewsAgg[0] ?? defaultReviewRow()
  const s = sessionsAgg[0] ?? { today_count: '0', week_count: '0' }
  const f = forecastAgg[0] ?? { due_now: '0', due_next_24h: '0', active_total: '0' }

  // Streak logic (copied from stats router)
  const todayStart = new Date(dayStartTs)
  let streak = 0
  let expectedDate = new Date(todayStart)

  for (const row of streakRows) {
    const rowDate = new Date(row.review_date)
    if (streak === 0 && rowDate.getTime() < expectedDate.getTime()) {
      const yesterday = new Date(expectedDate)
      yesterday.setDate(yesterday.getDate() - 1)
      if (rowDate.getTime() === yesterday.getTime()) {
        streak++
        expectedDate = yesterday
        continue
      } else {
        break
      }
    }
    if (rowDate.getTime() === expectedDate.getTime()) {
      streak++
      expectedDate.setDate(expectedDate.getDate() - 1)
    } else {
      break
    }
  }

  return {
    reviews: {
      today: { count: toInt(r.today_count), correct: toInt(r.today_correct) },
      last_7d: { count: toInt(r.week_count), correct: toInt(r.week_correct) },
      last_30d: { count: toInt(r.month_count), correct: toInt(r.month_correct) },
    },
    sessions: {
      today: toInt(s.today_count),
      last_7d: toInt(s.week_count),
    },
    forecast: {
      due_now: toInt(f.due_now),
      due_next_24h: toInt(f.due_next_24h),
      active_total: toInt(f.active_total),
    },
    heatmap: heatmapRows.map((row) => ({ date: row.day, count: toInt(row.cnt) })),
    recent_sessions: recentRows.map((row) => ({
      id: row.id,
      // postgres-js usually hands back timestamptz as Date, but some
      // driver configurations (CI in particular) return strings — same
      // tolerance as /cards/sources and /agent/questions/pending. The
      // `!` on finishedAt is load-bearing: the WHERE isNotNull filter
      // upstream guarantees it.
      started_at: toIso(row.startedAt),
      finished_at: toIso(row.finishedAt!),
      cards_reviewed: row.cardsReviewed,
      cards_correct: row.cardsCorrect,
    })),
    learned_count: toInt(learnedAgg[0]?.count),
    streak,
    generated_at: when.toISOString(),
  }
}

function defaultReviewRow() {
  return {
    today_count: '0',
    today_correct: '0',
    week_count: '0',
    week_correct: '0',
    month_count: '0',
    month_correct: '0',
  }
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d)
}

function toInt(s: string | number | null | undefined): number {
  if (s === null || s === undefined) return 0
  if (typeof s === 'number') return s
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : 0
}

export type FinishSessionResult =
  | { finishedAt: Date }
  | 'not_found'
  | 'already_finished'

export async function finishSession(
  db: Db,
  sessionId: string,
  cardsReviewed: number,
  cardsCorrect: number,
  finishedAt: Date,
): Promise<FinishSessionResult> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update')
    if (row === undefined) return 'not_found'
    if (row.finishedAt !== null) return 'already_finished'

    await tx
      .update(sessions)
      .set({
        finishedAt,
        cardsReviewed,
        cardsCorrect,
      })
      .where(eq(sessions.id, sessionId))

    return { finishedAt }
  })
}
