// Agent-facing read-only view of where the learner is actually weak.
//
// Without this, Hermes has no basis for composing an assignment: card_reviews
// is written on every rating but never exposed, so the agent would be
// guessing. Three overlapping lenses are returned rather than one ranked
// list, because they answer different questions:
//   * overdue — the schedule says it's late
//   * leeches — it keeps being forgotten no matter the schedule
//   * fragile — it's rated hard and the memory is short, so it's about to lapse
// The agent decides how to weigh them; the backend just measures.

import { Hono } from 'hono'
import { and, asc, count, desc, eq, gte, lt, lte, sql } from 'drizzle-orm'
import type { DiagnosticsCardDto, DiagnosticsResponse } from '@oxenfurt/shared'
import type { Db } from '../db/client.ts'
import { assignmentItems, assignments, cards, type CardRow } from '../db/schema.ts'
import { ingestTokenAuth } from '../middleware/ingest-token.ts'
import { expireStaleAssignments } from '../assignments/service.ts'

/** Lapse count at which a card stops being "hard" and starts being a leech. */
const LEECH_LAPSES = 4
/** Stability below this many days means the memory won't survive a week. */
const FRAGILE_STABILITY_DAYS = 3
/** Difficulty above this (FSRS scale is 1..10) means the card fights back. */
const FRAGILE_DIFFICULTY = 7
const DEFAULT_LIMIT = 200

export interface DiagnosticsRouterDeps {
  db: Db
  ingestToken: string
  now?: () => Date
}

export function createDiagnosticsRouter(deps: DiagnosticsRouterDeps): Hono {
  const app = new Hono()
  const now = deps.now ?? (() => new Date())
  app.use('*', ingestTokenAuth({ ingestToken: deps.ingestToken }))

  app.get('/', async (c) => {
    const at = now()
    const limitRaw = c.req.query('limit') ?? String(DEFAULT_LIMIT)
    const limit = Math.max(1, Math.min(DEFAULT_LIMIT, Number.parseInt(limitRaw, 10) || DEFAULT_LIMIT))

    await expireStaleAssignments(deps.db, at)

    const endOfToday = new Date(at)
    endOfToday.setUTCHours(23, 59, 59, 999)

    // Note the split between rows and counts: the row lists are capped by
    // `limit`, so the summary must come from real COUNTs or it would silently
    // under-report the moment the learner has more than `limit` overdue cards.
    const [
      overdueRows,
      leechRows,
      fragileRows,
      activeCount,
      overdueCount,
      dueTodayCount,
      leechCount,
    ] = await Promise.all([
      // Strictly before `at` — a card due at this exact instant (e.g. a
      // brand-new card, whose due defaults to its creation time) is due
      // now, not late yet.
      deps.db
        .select()
        .from(cards)
        .where(and(eq(cards.status, 'active'), lt(cards.due, at)))
        .orderBy(asc(cards.due))
        .limit(limit),
      deps.db
        .select()
        .from(cards)
        .where(and(eq(cards.status, 'active'), gte(cards.lapses, LEECH_LAPSES)))
        .orderBy(desc(cards.lapses))
        .limit(limit),
      deps.db
        .select()
        .from(cards)
        .where(
          and(
            eq(cards.status, 'active'),
            gte(cards.difficulty, FRAGILE_DIFFICULTY),
            lte(cards.stability, FRAGILE_STABILITY_DAYS),
          ),
        )
        .orderBy(asc(cards.stability))
        .limit(limit),
      deps.db.select({ value: count() }).from(cards).where(eq(cards.status, 'active')),
      deps.db
        .select({ value: count() })
        .from(cards)
        .where(and(eq(cards.status, 'active'), lt(cards.due, at))),
      deps.db
        .select({ value: count() })
        .from(cards)
        .where(and(eq(cards.status, 'active'), lte(cards.due, endOfToday))),
      deps.db
        .select({ value: count() })
        .from(cards)
        .where(and(eq(cards.status, 'active'), gte(cards.lapses, LEECH_LAPSES))),
    ])

    const recentSources = await deps.db
      .select({
        source: cards.source,
        cards: count(),
        latest: sql<string>`max(${cards.createdAt})`,
      })
      .from(cards)
      .where(and(eq(cards.status, 'active'), sql`${cards.source} IS NOT NULL`))
      .groupBy(cards.source)
      .orderBy(desc(sql`max(${cards.createdAt})`))
      .limit(10)

    const response: DiagnosticsResponse = {
      summary: {
        active_cards: activeCount[0]?.value ?? 0,
        overdue: overdueCount[0]?.value ?? 0,
        due_today: dueTodayCount[0]?.value ?? 0,
        leeches: leechCount[0]?.value ?? 0,
      },
      overdue: overdueRows.map((r) => toDiagnosticsCard(r, at)),
      leeches: leechRows.map((r) => toDiagnosticsCard(r, at)),
      fragile: fragileRows.map((r) => toDiagnosticsCard(r, at)),
      recent_sources: recentSources.map((r) => ({
        source: r.source!,
        cards: Number(r.cards),
        latest: new Date(r.latest).toISOString(),
      })),
      last_assignment: await loadLastAssignment(deps.db),
    }

    return c.json(response)
  })

  return app
}

async function loadLastAssignment(db: Db): Promise<DiagnosticsResponse['last_assignment']> {
  const [row] = await db
    .select()
    .from(assignments)
    .orderBy(desc(assignments.createdAt))
    .limit(1)
  if (row === undefined) return null

  const items = await db
    .select({ cardId: assignmentItems.cardId, completedAt: assignmentItems.completedAt })
    .from(assignmentItems)
    .innerJoin(cards, eq(cards.id, assignmentItems.cardId))
    .where(and(eq(assignmentItems.assignmentId, row.id), eq(cards.status, 'active')))

  return {
    id: row.id,
    title: row.title,
    status: row.status,
    due_at: row.dueAt.toISOString(),
    completed: items.filter((i) => i.completedAt !== null).length,
    total: items.length,
    unfinished_card_ids: items.filter((i) => i.completedAt === null).map((i) => i.cardId),
  }
}

function toDiagnosticsCard(row: CardRow, at: Date): DiagnosticsCardDto {
  const overdueMs = at.getTime() - row.due.getTime()
  return {
    card_id: row.id,
    type: row.type,
    label: labelOf(row),
    source: row.source,
    due: row.due.toISOString(),
    days_overdue: overdueMs > 0 ? Math.floor(overdueMs / 86_400_000) : 0,
    lapses: row.lapses,
    reps: row.reps,
    difficulty: row.difficulty,
    stability: row.stability,
    last_review: row.lastReview === null ? null : row.lastReview.toISOString(),
  }
}

/** Shortest human-identifying string per card type — the agent reasons in
 *  terms of words, not uuids. Theory questions are clipped so a long rule
 *  can't dominate the payload. */
function labelOf(row: CardRow): string {
  const payload = row.payload as Record<string, unknown>
  const raw =
    typeof payload.term === 'string'
      ? payload.term
      : typeof payload.phrase === 'string'
        ? payload.phrase
        : typeof payload.question === 'string'
          ? payload.question
          : row.id
  return raw.length > 120 ? `${raw.slice(0, 117)}…` : raw
}
