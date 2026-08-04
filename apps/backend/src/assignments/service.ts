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
): Promise<ActiveAssignmentResponse> {
  await expireStaleAssignments(db, now)

  const [row] = await db.select().from(assignments).where(eq(assignments.status, 'active'))
  if (row === undefined) return { assignment: null, items: [] }

  const rows = await db
    .select({ item: assignmentItems, card: cards })
    .from(assignmentItems)
    .innerJoin(cards, eq(cards.id, assignmentItems.cardId))
    .where(and(eq(assignmentItems.assignmentId, row.id), eq(cards.status, 'active')))
    .orderBy(asc(assignmentItems.position))

  const items: AssignmentItemDto[] = rows.map(({ item, card }) => ({
    card: toDueDto(card),
    group_label: item.groupLabel,
    group_kind: item.groupKind,
    position: item.position,
    completed_at: item.completedAt === null ? null : item.completedAt.toISOString(),
  }))

  return { assignment: toAssignmentDto(row, items), items }
}

export async function listAssignments(
  db: Db,
  now: Date,
  limit = 50,
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
 */
export async function markCardCompleted(db: Queryable, cardId: string, at: Date): Promise<void> {
  const [active] = await db.select().from(assignments).where(eq(assignments.status, 'active'))
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

  await settleActiveAssignment(db, at)
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
export async function settleActiveAssignment(db: Queryable, at: Date): Promise<void> {
  const [active] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.status, 'active'))
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
