// Legacy thin wrappers that project `computeStats` (in sessions/router)
// into the shapes the Mini App's two original endpoints returned. Kept
// so the Mini App keeps working without a refactor; ALL stats SQL lives
// in `computeStats` — there is no duplicate aggregation in this file
// anymore. Previously this router had its own ~130 LOC of queries that
// drifted from sessions/router's copy (the regressed FSRS-state column
// reference was first spotted here, then re-fixed in sessions when it
// copied the bug).
//
// New code should call /sessions/stats directly instead.

import { Hono } from 'hono'
import type { Db } from '../db/client.ts'
import type { ScopeRow } from '../db/schema.ts'
import { jwtAuthWithScope } from '../middleware/scope.ts'
import { computeStats } from '../sessions/router.ts'

export interface StatsRouterDeps {
  db: Db
  jwtSecret: string
  scopes: ScopeRow[]
  now?: () => Date
}

export function createStatsRouter(deps: StatsRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use(
    '*',
    jwtAuthWithScope({ jwtSecret: deps.jwtSecret, scopes: deps.scopes, now }),
  )

  app.get('/today', async (c) => {
    const stats = await computeStats(deps.db, now(), c.get('scope').id)
    return c.json({
      reviewedToday: stats.reviews.today.count,
      dueCount: stats.forecast.due_now,
      learnedCount: stats.learned_count,
      streak: stats.streak,
    })
  })

  app.get('/heatmap', async (c) => {
    const stats = await computeStats(deps.db, now(), c.get('scope').id)
    return c.json({ history: stats.heatmap })
  })

  return app
}
