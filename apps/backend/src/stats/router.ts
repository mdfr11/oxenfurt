import { Hono } from 'hono'
import { and, asc, count, desc, eq, gte, lte, sql } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { cardReviews, cards } from '../db/schema.ts'
import { jwtAuth } from '../middleware/auth.ts'

export interface StatsRouterDeps {
  db: Db
  jwtSecret: string
  now?: () => Date
}

export function createStatsRouter(deps: StatsRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use('*', jwtAuth({ jwtSecret: deps.jwtSecret, now }))

  app.get('/today', async (c) => {
    const todayStart = new Date(now())
    todayStart.setHours(0, 0, 0, 0)
    const tomorrowStart = new Date(todayStart)
    tomorrowStart.setDate(tomorrowStart.getDate() + 1)

    // 1. Cards reviewed today
    const reviewedTodayRes = await deps.db
      .select({ count: count() })
      .from(cardReviews)
      .where(
        and(
          gte(cardReviews.reviewedAt, todayStart),
          lte(cardReviews.reviewedAt, tomorrowStart)
        )
      )
    const reviewedToday = reviewedTodayRes[0]?.count ?? 0

    // 2. Cards due (active cards where due <= now)
    const dueRes = await deps.db
      .select({ count: count() })
      .from(cards)
      .where(
        and(
          eq(cards.status, 'active'),
          lte(cards.due, now())
        )
      )
    const dueCount = dueRes[0]?.count ?? 0

    // 3. Streak calculation
    // This is a naive streak calculation: we fetch distinct review dates (in local time)
    // and count backwards.
    // For a more robust timezone-aware streak, we'd group by Date(reviewedAt) in SQL.
    const streakRes = await deps.db.execute<{ review_date: Date }>(sql`
      SELECT DISTINCT date_trunc('day', reviewed_at) as review_date
      FROM ${cardReviews}
      ORDER BY review_date DESC
    `)

    let streak = 0
    let expectedDate = new Date(todayStart)

    for (const row of streakRes) {
      const rowDate = new Date(row.review_date)
      // If the user hasn't reviewed today yet, but reviewed yesterday,
      // the streak is still alive, we just start counting from yesterday.
      if (streak === 0 && rowDate.getTime() < expectedDate.getTime()) {
        const yesterday = new Date(expectedDate)
        yesterday.setDate(yesterday.getDate() - 1)
        if (rowDate.getTime() === yesterday.getTime()) {
          streak++
          expectedDate = yesterday
          continue
        } else {
          break // Streak broken
        }
      }

      if (rowDate.getTime() === expectedDate.getTime()) {
        streak++
        expectedDate.setDate(expectedDate.getDate() - 1)
      } else {
        break // Gap found
      }
    }

    return c.json({
      reviewedToday,
      dueCount,
      streak,
    })
  })

  return app
}
