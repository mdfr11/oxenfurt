// GET /scopes — the switcher's data. One row per configured scope with
// the numbers the pills need: due count (badge), learned count (rank)
// and whether an assignment is live (Home decides its primary action
// from it). One grouped query per metric, not one per scope — the list
// is polled on the Home cadence.

import { Hono } from 'hono'
import { and, count, eq, lte, sql } from 'drizzle-orm'
import type { ScopeRow } from '../db/schema.ts'
import type { ScopesResponse, ScopeSummaryDto } from '@oxenfurt/shared'
import type { Db } from '../db/client.ts'
import { assignments, cards } from '../db/schema.ts'
import { jwtAuthWithScope } from '../middleware/scope.ts'

export interface ScopesRouterDeps {
  db: Db
  jwtSecret: string
  scopes: ScopeRow[]
  now?: () => Date
}

export function createScopesRouter(deps: ScopesRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  app.use('*', jwtAuthWithScope({ jwtSecret: deps.jwtSecret, scopes: deps.scopes, now }))

  app.get('/', async (c) => {
    const at = now()
    const [dueRows, learnedRows, assignmentRows] = await Promise.all([
      deps.db
        .select({ scopeId: cards.scopeId, value: count() })
        .from(cards)
        .where(and(eq(cards.status, 'active'), lte(cards.due, at)))
        .groupBy(cards.scopeId),
      deps.db
        .select({ scopeId: cards.scopeId, value: count() })
        .from(cards)
        .where(and(eq(cards.status, 'active'), sql`${cards.stability} >= 10`))
        .groupBy(cards.scopeId),
      deps.db
        .select({ scopeId: assignments.scopeId, value: count() })
        .from(assignments)
        .where(eq(assignments.status, 'active'))
        .groupBy(assignments.scopeId),
    ])

    const due = new Map(dueRows.map((r) => [r.scopeId, r.value]))
    const learned = new Map(learnedRows.map((r) => [r.scopeId, r.value]))
    const active = new Set(assignmentRows.map((r) => r.scopeId))

    const payload: ScopesResponse = {
      scopes: deps.scopes.map<ScopeSummaryDto>((row) => ({
        slug: row.slug,
        title: row.title,
        emoji: row.emoji,
        accent: row.accent,
        due_count: due.get(row.id) ?? 0,
        learned_count: learned.get(row.id) ?? 0,
        has_active_assignment: active.has(row.id),
      })),
    }
    return c.json(payload)
  })

  return app
}
