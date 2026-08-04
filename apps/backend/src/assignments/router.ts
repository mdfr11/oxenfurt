// HTTP surfaces for assignments.
//
//  1. Agent-facing POST /agent/assignments, gated by the ingest token
//     Hermes already carries. This is where the structural contract is
//     enforced: size, deadline sanity, card existence, single-active.
//     What goes INTO an assignment is the agent's call, documented in
//     deploy/hermes/skills/oxenfurt_assignments.md — the backend has no
//     opinion about pedagogy.
//
//  2. User-facing GET /assignments/active and GET /assignments (Task 5),
//     dual-auth so Hermes can read its own history back.

import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import * as v from 'valibot'
import { ASSIGNMENT_MAX_DUE_DAYS, CreateAssignmentSchema } from '@oxenfurt/shared'
import type { Db } from '../db/client.ts'
import { assignmentItems, assignments, cards } from '../db/schema.ts'
import { ingestTokenAuth } from '../middleware/ingest-token.ts'
import { expireStaleAssignments } from './service.ts'

const MAX_DUE_MS = ASSIGNMENT_MAX_DUE_DAYS * 24 * 60 * 60 * 1000

export interface AgentAssignmentsRouterDeps {
  db: Db
  ingestToken: string
  now?: () => Date
}

export function createAgentAssignmentsRouter(deps: AgentAssignmentsRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())
  app.use('*', ingestTokenAuth({ ingestToken: deps.ingestToken }))

  app.post('/', async (c) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    }

    const parsed = v.safeParse(CreateAssignmentSchema, raw)
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', issues: parsed.issues }, 400)
    }
    const input = parsed.output
    const at = now()

    const dueAt = new Date(input.due_at)
    if (dueAt.getTime() <= at.getTime() || dueAt.getTime() - at.getTime() > MAX_DUE_MS) {
      return c.json({ error: 'invalid_due_at' }, 400)
    }

    const cardIds = input.items.map((i) => i.card_id)
    const unique = new Set(cardIds)
    if (unique.size !== cardIds.length) {
      return c.json({ error: 'duplicate_cards' }, 400)
    }

    const found = await deps.db
      .select({ id: cards.id })
      .from(cards)
      .where(and(inArray(cards.id, cardIds), eq(cards.status, 'active')))
    const foundIds = new Set(found.map((r) => r.id))
    const missing = cardIds.filter((id) => !foundIds.has(id))
    if (missing.length > 0) {
      return c.json({ error: 'unknown_cards', card_ids: missing }, 400)
    }

    // Deadlines that already passed must not count as "occupied" — expire
    // them first so a stale assignment can't wedge the single-active slot.
    await expireStaleAssignments(deps.db, at)

    const [live] = await deps.db.select().from(assignments).where(eq(assignments.status, 'active'))
    if (live !== undefined) {
      if (!input.replace) {
        return c.json({ error: 'assignment_active', assignment_id: live.id }, 409)
      }
      await deps.db
        .update(assignments)
        .set({ status: 'expired' })
        .where(eq(assignments.id, live.id))
    }

    const created = await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(assignments)
        .values({
          title: input.title,
          rationale: input.rationale ?? null,
          source: input.source ?? null,
          dueAt,
          createdAt: at,
        })
        .returning()

      await tx.insert(assignmentItems).values(
        input.items.map((item, position) => ({
          assignmentId: row!.id,
          cardId: item.card_id,
          groupLabel: item.group_label,
          groupKind: item.group_kind,
          position,
        })),
      )

      return row!
    })

    return c.json({ assignment_id: created.id, items: input.items.length })
  })

  return app
}
