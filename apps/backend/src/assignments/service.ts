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
