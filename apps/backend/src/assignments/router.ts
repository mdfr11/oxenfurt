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
import postgres from 'postgres'
import { ASSIGNMENT_MAX_DUE_DAYS, CreateAssignmentSchema } from '@oxenfurt/shared'
import type { Db } from '../db/client.ts'
import { assignmentItems, assignments, cards } from '../db/schema.ts'
import { ingestTokenAuth } from '../middleware/ingest-token.ts'
import { jwtAuth } from '../middleware/auth.ts'
import { expireStaleAssignments, listAssignments, loadActiveAssignment } from './service.ts'

const MAX_DUE_MS = ASSIGNMENT_MAX_DUE_DAYS * 24 * 60 * 60 * 1000

// Postgres SQLSTATE for a unique-constraint violation. The single-active
// invariant is enforced for real by `idx_assignments_single_active` (a
// partial unique index — see drizzle/0006_assignments.sql), not by the
// check-then-act read above. Two racing requests can both pass that read;
// only one of their inserts wins, and the loser lands here.
const UNIQUE_VIOLATION = '23505'
const SINGLE_ACTIVE_CONSTRAINT = 'idx_assignments_single_active'

function isSingleActiveViolation(err: unknown): boolean {
  return (
    err instanceof postgres.PostgresError &&
    err.code === UNIQUE_VIOLATION &&
    err.constraint_name === SINGLE_ACTIVE_CONSTRAINT
  )
}

/**
 * "There is already a live assignment and the caller didn't ask to replace
 * it." Thrown from inside the create transaction so the check runs under the
 * same lock as the insert, and caught outside it so the 409 stays a distinct
 * outcome from a genuine rollback. A plain `c.json` return can't do this job:
 * the transaction has to unwind first, and only an exception unwinds it.
 */
class AssignmentActiveError extends Error {
  constructor(readonly assignmentId: string) {
    super('assignment_active')
    this.name = 'AssignmentActiveError'
  }
}

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

    // Expire → check → replace → insert all happen in ONE transaction. They
    // used to be four autocommits, which meant a failure anywhere after the
    // `expired` UPDATE left the learner with no active assignment AND the
    // previous one falsely marked expired: work destroyed, nothing to
    // replace it. Rolling the lot into a transaction makes the replacement
    // all-or-nothing.
    let created: typeof assignments.$inferSelect
    try {
      created = await deps.db.transaction(async (tx) => {
        // Lock order is load-bearing. `applyReview` and `archiveCard` both
        // take the card row first and the assignment row second; the item
        // insert below takes the FK's KEY SHARE on exactly these cards, so
        // taking it here — BEFORE we touch the assignment row — keeps this
        // path in the same card-then-assignment order and no cycle is
        // reachable. It also closes the window where a card is deleted
        // between the existence check above and the insert.
        await tx.select({ id: cards.id }).from(cards).where(inArray(cards.id, cardIds)).for('key share')

        // Deadlines that already passed must not count as "occupied" —
        // expire them first so a stale assignment can't wedge the
        // single-active slot.
        await expireStaleAssignments(tx, at)

        const [live] = await tx
          .select()
          .from(assignments)
          .where(eq(assignments.status, 'active'))
          .for('update')
        if (live !== undefined) {
          if (!input.replace) throw new AssignmentActiveError(live.id)
          await tx.update(assignments).set({ status: 'expired' }).where(eq(assignments.id, live.id))
        }

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
    } catch (err) {
      // Occupied slot, seen under the lock. Same 409 the race below returns.
      if (err instanceof AssignmentActiveError) {
        return c.json({ error: 'assignment_active', assignment_id: err.assignmentId }, 409)
      }
      // A concurrent request won the race between our locked read and our
      // insert — possible because the loser's `FOR UPDATE` can't see the
      // winner's uncommitted row. Report the same 409, so callers see one
      // consistent contract either way.
      if (isSingleActiveViolation(err)) {
        return c.json({ error: 'assignment_active' }, 409)
      }
      throw err
    }

    return c.json({ assignment_id: created.id, items: input.items.length })
  })

  return app
}

export interface UserAssignmentsRouterDeps {
  db: Db
  jwtSecret: string
  /** Hermes reads its own history back through the same routes. */
  ingestToken: string
  now?: () => Date
}

export function createUserAssignmentsRouter(deps: UserAssignmentsRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())

  // Same dual-auth shape as the cards router: agent bypass first, JWT
  // otherwise. Keeps one read surface instead of mirroring these routes
  // under /agent.
  app.use('*', async (c, next) => {
    const auth = c.req.header('authorization') ?? ''
    const match = auth.match(/^bearer\s+(.+)$/i)
    if (match && match[1] === deps.ingestToken) return next()
    return jwtAuth({ jwtSecret: deps.jwtSecret, now })(c, next)
  })

  app.get('/active', async (c) => {
    return c.json(await loadActiveAssignment(deps.db, now()))
  })

  app.get('/', async (c) => {
    const limitRaw = c.req.query('limit') ?? '50'
    const limit = Math.max(1, Math.min(100, Number.parseInt(limitRaw, 10) || 50))
    return c.json({ assignments: await listAssignments(deps.db, now(), limit) })
  })

  return app
}
