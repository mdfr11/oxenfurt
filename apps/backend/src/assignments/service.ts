// Read-side and accounting helpers for assignments. Deliberately free of
// HTTP concerns so the review path (cards/router.ts) can reuse
// `markCardCompleted` inside its existing transaction without importing a
// Hono router.
//
// Two invariants live here:
//   1. Expiry is lazy — every read path calls expireStaleAssignments first,
//      so no scheduler is needed and a missed deadline can never be served
//      as if it were live.
//   2. Archived cards are invisible to assignments. They drop out of the
//      queue AND out of the denominator, so archiving the last unfinished
//      card completes the assignment rather than stranding it forever.

import { and, asc, desc, eq, isNull, lt, sql } from 'drizzle-orm'
import type {
  ActiveAssignmentResponse,
  AssignmentDetailResponse,
  AssignmentDto,
  AssignmentGroupDto,
  AssignmentItemDto,
  AssignmentListItemDto,
} from '@oxenfurt/shared'
import type { Db } from '../db/client.ts'
import { toDueDto } from '../cards/dto.ts'
import { assignmentItems, assignments, cards, type AssignmentRow } from '../db/schema.ts'

/** Anything that can run queries — the real Db or a Drizzle transaction. */
type Queryable = Pick<Db, 'select' | 'update' | 'insert' | 'delete'>

export async function expireStaleAssignments(db: Queryable, now: Date): Promise<void> {
  await db
    .update(assignments)
    .set({ status: 'expired' })
    .where(and(eq(assignments.status, 'active'), lt(assignments.dueAt, now)))
}

export async function loadActiveAssignment(
  db: Db,
  now: Date,
  scopeId: string,
): Promise<ActiveAssignmentResponse> {
  await expireStaleAssignments(db, now)

  const [row] = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.status, 'active'), eq(assignments.scopeId, scopeId)))
  if (row === undefined) return { assignment: null, items: [] }

  const items = await loadAssignmentItems(db, row.id)
  return { assignment: toAssignmentDto(row, items), items }
}

/**
 * One assignment by id with its cards, for the history detail sheet and for
 * drill sessions. Lazy expiry runs first, so an overdue assignment is never
 * served as `active` — a drill started from history sees the real status.
 */
export async function loadAssignmentById(
  db: Db,
  id: string,
  now: Date,
  scopeId?: string,
): Promise<AssignmentDetailResponse | null> {
  await expireStaleAssignments(db, now)

  const [row] = await db
    .select()
    .from(assignments)
    .where(
      scopeId === undefined
        ? eq(assignments.id, id)
        : and(eq(assignments.id, id), eq(assignments.scopeId, scopeId)),
    )
  if (row === undefined) return null

  const items = await loadAssignmentItems(db, row.id)
  return { assignment: toAssignmentDto(row, items), items }
}

/**
 * The most recently created assignment in a scope, regardless of status.
 * Home shows it as a "done — replay" card until its deadline; without this
 * the finished assignment disappears the moment the last card is taken,
 * which is exactly when the learner wants to run it again.
 */
export async function loadLatestAssignment(
  db: Db,
  now: Date,
  scopeId: string,
): Promise<AssignmentDto | null> {
  await expireStaleAssignments(db, now)

  const [row] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.scopeId, scopeId))
    .orderBy(desc(assignments.createdAt))
    .limit(1)
  if (row === undefined) return null

  return toAssignmentDto(row, await loadAssignmentItems(db, row.id))
}

async function loadAssignmentItems(
  db: Queryable,
  assignmentId: string,
): Promise<AssignmentItemDto[]> {
  const rows = await db
    .select({ item: assignmentItems, card: cards })
    .from(assignmentItems)
    .innerJoin(cards, eq(cards.id, assignmentItems.cardId))
    .where(and(eq(assignmentItems.assignmentId, assignmentId), eq(cards.status, 'active')))
    .orderBy(asc(assignmentItems.position))

  return rows.map(({ item, card }) => ({
    card: toDueDto(card),
    group_label: item.groupLabel,
    group_kind: item.groupKind,
    position: item.position,
    completed_at: item.completedAt === null ? null : item.completedAt.toISOString(),
  }))
}

export async function listAssignments(
  db: Db,
  now: Date,
  limit = 50,
  scopeId?: string,
): Promise<AssignmentListItemDto[]> {
  await expireStaleAssignments(db, now)

  const rows = await db
    .select({
      assignment: assignments,
      total: sql<number>`count(${assignmentItems.cardId}) filter (where ${cards.status} = 'active')`,
      completed: sql<number>`count(${assignmentItems.completedAt}) filter (where ${cards.status} = 'active')`,
    })
    .from(assignments)
    .leftJoin(assignmentItems, eq(assignmentItems.assignmentId, assignments.id))
    .leftJoin(cards, eq(cards.id, assignmentItems.cardId))
    .where(scopeId === undefined ? undefined : eq(assignments.scopeId, scopeId))
    .groupBy(assignments.id)
    .orderBy(desc(assignments.createdAt))
    .limit(limit)

  return rows.map(({ assignment, total, completed }) => ({
    id: assignment.id,
    title: assignment.title,
    status: assignment.status,
    due_at: assignment.dueAt.toISOString(),
    created_at: assignment.createdAt.toISOString(),
    completed_at: assignment.completedAt === null ? null : assignment.completedAt.toISOString(),
    completed: Number(completed),
    total: Number(total),
  }))
}

/**
 * Records that `cardId` was taken (rated Good or better) at `at`. No-op when
 * the card isn't part of the active assignment, and never overwrites an
 * earlier completion. Flips the assignment to `completed` when no unfinished
 * non-archived item remains.
 *
 * Safe to call inside an outer transaction — pass the transaction as `db`.
 *
 * The `FOR UPDATE` here is hardening rather than a fix: it takes the same
 * lock `settleActiveAssignment` takes below, one step earlier, so the row
 * this function stamps against is provably the row that then gets settled.
 * Without it a `replace` landing between the two reads would send the stamp
 * to the just-expired assignment — which inflates a history count by one but
 * cannot wrongly complete anything. Holding it across both reads means a
 * reader doesn't have to reconstruct that argument.
 */
export async function markCardCompleted(
  db: Queryable,
  scopeId: string,
  cardId: string,
  at: Date,
): Promise<void> {
  // One active assignment PER SCOPE — the scope's own slot is the only
  // one a card of that scope can move.
  const [active] = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.status, 'active'), eq(assignments.scopeId, scopeId)))
    .for('update')
  if (active === undefined) return

  const updated = await db
    .update(assignmentItems)
    .set({ completedAt: at })
    .where(
      and(
        eq(assignmentItems.assignmentId, active.id),
        eq(assignmentItems.cardId, cardId),
        isNull(assignmentItems.completedAt),
      ),
    )
    .returning({ cardId: assignmentItems.cardId })

  if (updated.length === 0) return

  await settleActiveAssignment(db, scopeId, at)
}

/**
 * Completes the active assignment when it has no unfinished, non-archived
 * items left. Called from two places: after a card is taken (rating ≥ Good)
 * and after a card is archived. Archiving the last owed card settles the
 * assignment rather than stranding it — declining a card is a decision, not
 * a skip, and a stuck 'active' row would hold the Home screen and block new
 * assignments with 409 until the deadline lapsed.
 *
 * `FOR UPDATE` on the assignment row is load-bearing, not decoration: this
 * is check-then-act (read "remaining", then maybe write "completed"), and
 * the last two items of a session routinely land within milliseconds of
 * each other. Without the lock, two concurrent completions each run their
 * "remaining" query against a snapshot that doesn't yet include the other's
 * uncommitted stamp, both see one item outstanding, and neither settles —
 * the assignment is done but stuck 'active' forever. The lock serializes
 * the two calls: whichever commits second re-reads the row (and therefore
 * `assignment_items`) only after the first's stamp is visible, so it's the
 * one that observes zero remaining and flips the status. A plain
 * NOT EXISTS/UPDATE has the identical blind spot — the subquery still can't
 * see the other transaction's uncommitted row — only serializing the two
 * call paths on this lock closes it. Callers that also lock rows (the card
 * row in `applyReview`/`archiveCard`) take that lock first, so the order is
 * always card-then-assignment and this can't deadlock against them.
 */
export async function settleActiveAssignment(
  db: Queryable,
  scopeId: string,
  at: Date,
): Promise<void> {
  const [active] = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.status, 'active'), eq(assignments.scopeId, scopeId)))
    .for('update')
  if (active === undefined) return

  const remaining = await db
    .select({ cardId: assignmentItems.cardId })
    .from(assignmentItems)
    .innerJoin(cards, eq(cards.id, assignmentItems.cardId))
    .where(
      and(
        eq(assignmentItems.assignmentId, active.id),
        eq(cards.status, 'active'),
        isNull(assignmentItems.completedAt),
      ),
    )

  if (remaining.length === 0) {
    await db
      .update(assignments)
      .set({ status: 'completed', completedAt: at })
      .where(eq(assignments.id, active.id))
  }
}

// Mapping -----------------------------------------------------------------

function toAssignmentDto(row: AssignmentRow, items: AssignmentItemDto[]): AssignmentDto {
  const groups: AssignmentGroupDto[] = []
  for (const item of items) {
    let group = groups.find((g) => g.label === item.group_label)
    if (group === undefined) {
      group = { label: item.group_label, kind: item.group_kind, total: 0, completed: 0 }
      groups.push(group)
    }
    group.total += 1
    if (item.completed_at !== null) group.completed += 1
  }

  return {
    id: row.id,
    title: row.title,
    rationale: row.rationale,
    status: row.status,
    source: row.source,
    created_at: row.createdAt.toISOString(),
    due_at: row.dueAt.toISOString(),
    completed_at: row.completedAt === null ? null : row.completedAt.toISOString(),
    completed: items.filter((i) => i.completed_at !== null).length,
    total: items.length,
    groups,
  }
}
