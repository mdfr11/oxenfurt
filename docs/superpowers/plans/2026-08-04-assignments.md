# Assignments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hermes composes a bounded, deadline-bound set of existing cards into an "assignment" that becomes the Mini App's primary screen, while free practice stays as the secondary mode.

**Architecture:** Two new tables (`assignments`, `assignment_items`) referencing existing `cards`. The backend owns structure, validation, single-active enforcement, lazy expiry and completion accounting; the agent owns card selection, documented in a new Hermes markdown skill. A new agent-facing diagnostics endpoint exposes FSRS weakness so selection can be evidence-based. `POST /cards/:id/review` gains a `drill` flag so cramming repeats stop writing to FSRS.

**Tech Stack:** Bun 1.3, Hono, Drizzle ORM + hand-written SQL migrations, valibot, Postgres 17, React 19, TanStack Query, Tailwind 4, Framer Motion, `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-04-assignments-design.md` — read it before starting.

## Global Constraints

- Backend and `packages/shared` code style: **no semicolons**, single quotes, 2-space indent. Mini-app code style: **semicolons**, single quotes.
- All backend imports of local modules use explicit `.ts` extensions (e.g. `from '../db/schema.ts'`).
- Validation uses **valibot** (`import * as v from 'valibot'`), never zod.
- Tests use `bun test` (`import { beforeEach, describe, expect, test } from 'bun:test'`). DB-backed tests use `getTestDb()` / `resetTestDb()` and must be wrapped in `describe.skipIf(noDb)` — never call `conn.close()`.
- Migrations are **hand-written SQL** in `apps/backend/drizzle/`, with `--> statement-breakpoint` between statements, and a matching entry appended to `apps/backend/drizzle/meta/_journal.json`. Do not run `drizzle-kit generate`.
- Entity naming: the new entity is **`assignment`**. The word "lesson" stays reserved for `cards.source`. Never name a table, column, type, route or i18n key `lesson`.
- UI copy is bilingual: every new key added to `apps/mini-app/src/lib/i18n/locales/ru.ts` must have an English counterpart in `en.ts` (TypeScript enforces this).
- Assignment size limits: **3..30** items. Title **1..120** chars. `rationale` **0..2000** chars. `group_label` **1..80** chars. `due_at` must be in the future and **≤ 30 days** out.
- Card completion threshold: rating **≥ 3 (Good)**. Ratings 1 and 2 never complete an item.
- The app must never show accumulating overdue debt for assignments: no red badges, no counters, no app-side reminders.
- Backend test command: `cd apps/backend && bun test <path>`. Mini-app test command: `cd apps/mini-app && bun test <path>`.

---

## File Structure

**Create**
- `apps/backend/drizzle/0006_assignments.sql` — tables, constraints, indexes.
- `packages/shared/src/schemas/assignment.ts` — valibot input schemas + response DTO types.
- `apps/backend/src/assignments/service.ts` — pure-ish DB helpers: expiry, active load, completion accounting. No HTTP.
- `apps/backend/src/assignments/service.test.ts`
- `apps/backend/src/assignments/router.ts` — `createUserAssignmentsRouter` + `createAgentAssignmentsRouter`.
- `apps/backend/src/assignments/router.test.ts`
- `apps/backend/src/diagnostics/router.ts` — `createDiagnosticsRouter`.
- `apps/backend/src/diagnostics/router.test.ts`
- `apps/mini-app/src/hooks/useActiveAssignment.ts` — query hook + derived view model.
- `apps/mini-app/src/components/AssignmentCard.tsx` — the Home block (title, deadline, groups).
- `apps/mini-app/src/components/assignmentHelpers.ts` — pure helpers (queue build, drill decision, deadline formatting).
- `apps/mini-app/src/components/assignmentHelpers.test.ts`
- `apps/mini-app/src/components/AssignmentHistory.tsx` — history sheet.
- `deploy/hermes/skills/oxenfurt_assignments.md`

**Modify**
- `apps/backend/drizzle/meta/_journal.json` — append idx 6.
- `apps/backend/src/db/schema.ts` — add `assignments`, `assignmentItems`.
- `apps/backend/src/db/testing.ts` — truncate the new tables.
- `packages/shared/src/schemas/index.ts` — re-export the new module.
- `apps/backend/src/cards/router.ts` — `drill` flag on `POST /:id/review`, completion hook inside `applyReview`.
- `apps/backend/src/server/app.ts` — mount three new routers.
- `apps/mini-app/src/components/Home.tsx` — variant C layout when an assignment is active.
- `apps/mini-app/src/components/PracticeSession.tsx` — assignment queue source + drill flag.
- `apps/mini-app/src/App.tsx` — pass assignment mode into PracticeSession, wire history screen.
- `apps/mini-app/src/lib/i18n/locales/ru.ts` + `en.ts` — new keys.
- `README.md` — document the new agent surface.

---

### Task 1: Database schema and migration

**Files:**
- Create: `apps/backend/drizzle/0006_assignments.sql`
- Modify: `apps/backend/drizzle/meta/_journal.json`
- Modify: `apps/backend/src/db/schema.ts`
- Modify: `apps/backend/src/db/testing.ts:44-52`
- Test: `apps/backend/src/assignments/service.test.ts`

**Interfaces:**
- Consumes: existing `cards` table from `apps/backend/src/db/schema.ts`.
- Produces: Drizzle tables `assignments` and `assignmentItems`; types `AssignmentRow`, `AssignmentItemRow`; `AssignmentStatus = 'active' | 'completed' | 'expired'`; `GroupKind = 'topic' | 'new' | 'weak'`.

- [ ] **Step 1: Write the migration SQL**

Create `apps/backend/drizzle/0006_assignments.sql`:

```sql
-- Agent-authored assignments. Hermes composes a bounded set of EXISTING
-- cards into one deliverable with a deadline; the Mini App makes it the
-- primary screen. An assignment is a reference to cards plus a due date —
-- never a copy, never a separate deck. FSRS state stays single-sourced on
-- `cards`.
--
-- Lifecycle: created 'active' → 'completed' when every item is taken, or
-- 'expired' when due_at passes (flipped lazily on read) or when a
-- replacement assignment is created.

CREATE TABLE "assignments" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title"         text NOT NULL,
  "rationale"     text,
  "status"        text NOT NULL DEFAULT 'active',
  "source"        text,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "due_at"        timestamptz NOT NULL,
  "completed_at"  timestamptz,
  CONSTRAINT "assignments_status_check"
    CHECK ("status" IN ('active', 'completed', 'expired'))
);
--> statement-breakpoint

-- At most one active assignment, enforced by the database rather than by
-- application code. Two live assignments would resurrect the accumulating
-- debt this feature exists to remove.
CREATE UNIQUE INDEX "idx_assignments_single_active"
  ON "assignments" (("status"))
  WHERE "status" = 'active';
--> statement-breakpoint

-- History listing, newest first.
CREATE INDEX "idx_assignments_created"
  ON "assignments" ("created_at" DESC);
--> statement-breakpoint

CREATE TABLE "assignment_items" (
  "assignment_id" uuid NOT NULL REFERENCES "assignments"("id") ON DELETE CASCADE,
  "card_id"       uuid NOT NULL REFERENCES "cards"("id") ON DELETE CASCADE,
  "group_label"   text NOT NULL,
  "group_kind"    text NOT NULL,
  "position"      integer NOT NULL,
  "completed_at"  timestamptz,
  PRIMARY KEY ("assignment_id", "card_id"),
  CONSTRAINT "assignment_items_group_kind_check"
    CHECK ("group_kind" IN ('topic', 'new', 'weak'))
);
--> statement-breakpoint

-- Session ordering and progress aggregation both read by assignment.
CREATE INDEX "idx_assignment_items_order"
  ON "assignment_items" ("assignment_id", "position");
--> statement-breakpoint

-- Review-time lookup: "is this card part of the active assignment?"
CREATE INDEX "idx_assignment_items_card"
  ON "assignment_items" ("card_id");
```

- [ ] **Step 2: Register the migration in the journal**

Append to the `entries` array in `apps/backend/drizzle/meta/_journal.json`, after the `0005_backfill_session_correct` entry (mind the comma on the preceding `}`):

```json
    {
      "idx": 6,
      "version": "7",
      "when": 1785840000000,
      "tag": "0006_assignments",
      "breakpoints": true
    }
```

- [ ] **Step 3: Add the Drizzle table definitions**

Append to `apps/backend/src/db/schema.ts` (the file already imports `index`, `integer`, `pgTable`, `text`, `timestamp`, `uuid` — no import changes needed):

```ts
export type AssignmentStatus = 'active' | 'completed' | 'expired'
export type GroupKind = 'topic' | 'new' | 'weak'

export const assignments = pgTable(
  'assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    rationale: text('rationale'),
    status: text('status').$type<AssignmentStatus>().notNull().default('active'),
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [index('idx_assignments_created').on(t.createdAt)],
)

export type AssignmentRow = typeof assignments.$inferSelect

export const assignmentItems = pgTable(
  'assignment_items',
  {
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    groupLabel: text('group_label').notNull(),
    groupKind: text('group_kind').$type<GroupKind>().notNull(),
    position: integer('position').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    primaryKey({ columns: [t.assignmentId, t.cardId] }),
    index('idx_assignment_items_order').on(t.assignmentId, t.position),
    index('idx_assignment_items_card').on(t.cardId),
  ],
)

export type AssignmentItemRow = typeof assignmentItems.$inferSelect
```

Add `primaryKey` to the existing `drizzle-orm/pg-core` import list at the top of the file.

- [ ] **Step 4: Truncate the new tables between tests**

In `apps/backend/src/db/testing.ts`, change the `TRUNCATE` statement inside `resetTestDb` to:

```ts
  await db.execute(sql`
    TRUNCATE TABLE assignment_items, assignments, card_questions, card_reviews, sessions, cards
    RESTART IDENTITY CASCADE
  `)
```

- [ ] **Step 5: Write the failing schema smoke test**

Create `apps/backend/src/assignments/service.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test'
import { FsrsService } from '@oxenfurt/shared'
import { getTestDb, resetTestDb } from '../db/testing.ts'
import { assignmentItems, assignments, cards } from '../db/schema.ts'
import { ingestCards } from '../ingest/cards.ts'

const conn = await getTestDb()
const noDb = conn === null
const NOW = new Date('2026-08-04T12:00:00.000Z')
const fsrs = new FsrsService({ enableFuzz: false })

beforeEach(async () => {
  if (conn) await resetTestDb(conn.db)
})

async function seedCards(count: number): Promise<string[]> {
  await ingestCards(
    conn!.db,
    fsrs,
    {
      cards: Array.from({ length: count }, (_, i) => ({
        type: 'vocab' as const,
        payload: {
          term: `term${i}`,
          translation: `перевод${i}`,
          context_sentence: `A sentence with term${i} inside.`,
          context_term_start: 14,
          context_term_end: 14 + `term${i}`.length,
        },
        source: 'lesson-2026-07-28',
      })),
    },
    NOW,
  )
  const rows = await conn!.db.select({ id: cards.id }).from(cards)
  return rows.map((r) => r.id)
}

describe.skipIf(noDb)('assignments schema', () => {
  test('allows only one active assignment', async () => {
    await conn!.db.insert(assignments).values({
      title: 'First',
      dueAt: new Date('2026-08-06T21:00:00.000Z'),
    })

    const second = conn!.db.insert(assignments).values({
      title: 'Second',
      dueAt: new Date('2026-08-07T21:00:00.000Z'),
    })

    expect(second).rejects.toThrow()
  })

  test('allows many non-active assignments alongside one active', async () => {
    await conn!.db.insert(assignments).values([
      { title: 'Done', status: 'completed', dueAt: NOW },
      { title: 'Missed', status: 'expired', dueAt: NOW },
      { title: 'Live', status: 'active', dueAt: new Date('2026-08-06T21:00:00.000Z') },
    ])
    const rows = await conn!.db.select().from(assignments)
    expect(rows).toHaveLength(3)
  })

  test('deleting an assignment cascades to its items', async () => {
    const [cardId] = await seedCards(1)
    const [row] = await conn!.db
      .insert(assignments)
      .values({ title: 'Live', dueAt: new Date('2026-08-06T21:00:00.000Z') })
      .returning()
    await conn!.db.insert(assignmentItems).values({
      assignmentId: row!.id,
      cardId: cardId!,
      groupLabel: 'Слова с урока',
      groupKind: 'new',
      position: 0,
    })

    await conn!.db.delete(assignments)
    const items = await conn!.db.select().from(assignmentItems)
    expect(items).toHaveLength(0)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd apps/backend && bun test src/assignments/service.test.ts`
Expected: FAIL — `relation "assignments" does not exist` (migrations haven't been applied to the test DB yet) or a TypeScript resolution error on `assignments` from `db/schema.ts`.

- [ ] **Step 7: Apply migrations and re-run**

`getTestDb()` runs migrations automatically on first access, so re-running the test is enough.

Run: `cd apps/backend && bun test src/assignments/service.test.ts`
Expected: PASS — 3 tests. If `TEST_DATABASE_URL` is unset the suite reports as skipped; set it against a scratch Postgres before continuing, because every remaining backend task is DB-backed.

- [ ] **Step 8: Typecheck**

Run: `cd apps/backend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/drizzle apps/backend/src/db/schema.ts apps/backend/src/db/testing.ts apps/backend/src/assignments/service.test.ts
git commit -m "feat(assignments): add assignments and assignment_items tables"
```

---

### Task 2: Shared schemas and DTO types

**Files:**
- Create: `packages/shared/src/schemas/assignment.ts`
- Modify: `packages/shared/src/schemas/index.ts`
- Test: `packages/shared/src/schemas/assignment.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks except the `GroupKind` concept (redeclared here as a valibot picklist — `packages/shared` must not import from `apps/backend`).
- Produces: `CreateAssignmentSchema`, `CreateAssignmentInput`, `GroupKindSchema`, `GroupKind`, and the response DTO interfaces `AssignmentGroupDto`, `AssignmentDto`, `AssignmentItemDto`, `ActiveAssignmentResponse`, `AssignmentListItemDto`, `DiagnosticsCardDto`, `DiagnosticsResponse`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/schemas/assignment.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import * as v from 'valibot'
import { CreateAssignmentSchema } from './assignment.ts'

const CARD_A = '11111111-1111-4111-8111-111111111111'
const CARD_B = '22222222-2222-4222-8222-222222222222'
const CARD_C = '33333333-3333-4333-8333-333333333333'

function item(cardId: string) {
  return { card_id: cardId, group_label: 'Второй кондиционал', group_kind: 'topic' as const }
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Условные предложения и лексика 28 июля',
    due_at: '2026-08-06T21:00:00.000Z',
    items: [item(CARD_A), item(CARD_B), item(CARD_C)],
    ...overrides,
  }
}

describe('CreateAssignmentSchema', () => {
  test('accepts a minimal valid assignment', () => {
    const parsed = v.safeParse(CreateAssignmentSchema, base())
    expect(parsed.success).toBe(true)
  })

  test('defaults replace to false', () => {
    const parsed = v.parse(CreateAssignmentSchema, base())
    expect(parsed.replace).toBe(false)
  })

  test('rejects fewer than 3 items', () => {
    const parsed = v.safeParse(CreateAssignmentSchema, base({ items: [item(CARD_A), item(CARD_B)] }))
    expect(parsed.success).toBe(false)
  })

  test('rejects more than 30 items', () => {
    const items = Array.from({ length: 31 }, () => item(CARD_A))
    const parsed = v.safeParse(CreateAssignmentSchema, base({ items }))
    expect(parsed.success).toBe(false)
  })

  test('rejects an empty title', () => {
    expect(v.safeParse(CreateAssignmentSchema, base({ title: '   ' })).success).toBe(false)
  })

  test('rejects a title longer than 120 chars', () => {
    expect(v.safeParse(CreateAssignmentSchema, base({ title: 'x'.repeat(121) })).success).toBe(false)
  })

  test('rejects an unknown group_kind', () => {
    const bad = [{ card_id: CARD_A, group_label: 'X', group_kind: 'bonus' }]
    expect(v.safeParse(CreateAssignmentSchema, base({ items: bad })).success).toBe(false)
  })

  test('rejects a non-uuid card_id', () => {
    const bad = [item(CARD_A), item(CARD_B), { ...item(CARD_C), card_id: 'nope' }]
    expect(v.safeParse(CreateAssignmentSchema, base({ items: bad })).success).toBe(false)
  })

  test('rejects a malformed due_at', () => {
    expect(v.safeParse(CreateAssignmentSchema, base({ due_at: 'tomorrow' })).success).toBe(false)
  })

  test('accepts rationale up to 2000 chars and rejects beyond', () => {
    expect(v.safeParse(CreateAssignmentSchema, base({ rationale: 'a'.repeat(2000) })).success).toBe(true)
    expect(v.safeParse(CreateAssignmentSchema, base({ rationale: 'a'.repeat(2001) })).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/shared && bun test src/schemas/assignment.test.ts`
Expected: FAIL — cannot resolve `./assignment.ts`.

- [ ] **Step 3: Write the schema module**

Create `packages/shared/src/schemas/assignment.ts`:

```ts
// Wire contract for agent-authored assignments. Input schemas are
// validated on the backend; the DTO interfaces below describe what the
// Mini App receives and are intentionally plain types (no runtime
// validation on the read path — same convention as DueCardDto).

import * as v from 'valibot'
import type { CardType, DueCardDto } from './card.ts'

export const GroupKindSchema = v.picklist(['topic', 'new', 'weak'] as const)
export type GroupKind = v.InferOutput<typeof GroupKindSchema>

export const ASSIGNMENT_MIN_ITEMS = 3
export const ASSIGNMENT_MAX_ITEMS = 30
/** Longest deadline the backend will accept, in days. Beyond this an
 *  "assignment" stops being a deliverable and becomes a backlog. */
export const ASSIGNMENT_MAX_DUE_DAYS = 30

const UuidSchema = v.pipe(v.string(), v.uuid())
const IsoDateSchema = v.pipe(v.string(), v.isoTimestamp())

export const AssignmentItemInputSchema = v.object({
  card_id: UuidSchema,
  group_label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  group_kind: GroupKindSchema,
})
export type AssignmentItemInput = v.InferOutput<typeof AssignmentItemInputSchema>

export const CreateAssignmentSchema = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  rationale: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
  due_at: IsoDateSchema,
  source: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  replace: v.optional(v.boolean(), false),
  items: v.pipe(
    v.array(AssignmentItemInputSchema),
    v.minLength(ASSIGNMENT_MIN_ITEMS),
    v.maxLength(ASSIGNMENT_MAX_ITEMS),
  ),
})
export type CreateAssignmentInput = v.InferOutput<typeof CreateAssignmentSchema>

export type AssignmentStatus = 'active' | 'completed' | 'expired'

export interface AssignmentGroupDto {
  label: string
  kind: GroupKind
  total: number
  completed: number
}

export interface AssignmentDto {
  id: string
  title: string
  rationale: string | null
  status: AssignmentStatus
  source: string | null
  created_at: string
  due_at: string
  completed_at: string | null
  /** Counts exclude items whose card has been archived. */
  completed: number
  total: number
  groups: AssignmentGroupDto[]
}

export interface AssignmentItemDto {
  card: DueCardDto
  group_label: string
  group_kind: GroupKind
  position: number
  completed_at: string | null
}

export interface ActiveAssignmentResponse {
  assignment: AssignmentDto | null
  items: AssignmentItemDto[]
}

export interface AssignmentListItemDto {
  id: string
  title: string
  status: AssignmentStatus
  due_at: string
  created_at: string
  completed_at: string | null
  completed: number
  total: number
}

export interface DiagnosticsCardDto {
  card_id: string
  type: CardType
  label: string
  source: string | null
  due: string
  days_overdue: number
  lapses: number
  reps: number
  difficulty: number
  stability: number
  last_review: string | null
}

export interface DiagnosticsSourceDto {
  source: string
  cards: number
  latest: string
}

export interface DiagnosticsLastAssignmentDto {
  id: string
  title: string
  status: AssignmentStatus
  due_at: string
  completed: number
  total: number
  unfinished_card_ids: string[]
}

export interface DiagnosticsResponse {
  summary: {
    active_cards: number
    overdue: number
    due_today: number
    leeches: number
  }
  overdue: DiagnosticsCardDto[]
  leeches: DiagnosticsCardDto[]
  fragile: DiagnosticsCardDto[]
  recent_sources: DiagnosticsSourceDto[]
  last_assignment: DiagnosticsLastAssignmentDto | null
}
```

- [ ] **Step 4: Export it from the barrel**

Add to `packages/shared/src/schemas/index.ts`:

```ts
export * from './assignment.ts'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/shared && bun test src/schemas/assignment.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 6: Typecheck**

Run: `cd packages/shared && pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/schemas/assignment.ts packages/shared/src/schemas/assignment.test.ts packages/shared/src/schemas/index.ts
git commit -m "feat(assignments): add shared wire schemas and DTO types"
```

---

### Task 3: Assignment service — expiry, load, completion

**Files:**
- Create: `apps/backend/src/cards/dto.ts`
- Create: `apps/backend/src/assignments/service.ts`
- Modify: `apps/backend/src/cards/router.ts` (import `toDueDto` instead of defining it)
- Modify: `apps/backend/src/assignments/service.test.ts` (append)
- Test: `apps/backend/src/assignments/service.test.ts`

**Interfaces:**
- Consumes: `assignments`, `assignmentItems`, `cards` from `../db/schema.ts`; `AssignmentDto`, `AssignmentItemDto`, `ActiveAssignmentResponse`, `AssignmentListItemDto` from `@oxenfurt/shared`.
- Produces: `toDueDto(row: CardRow, hasQuestions?: boolean): DueCardDto` from `apps/backend/src/cards/dto.ts` — moved verbatim out of `cards/router.ts` so both the cards router and the assignment service share one mapper instead of duplicating it.
- Produces:
  - `expireStaleAssignments(db: Db, now: Date): Promise<void>`
  - `loadActiveAssignment(db: Db, now: Date): Promise<ActiveAssignmentResponse>`
  - `listAssignments(db: Db, now: Date, limit?: number): Promise<AssignmentListItemDto[]>`
  - `markCardCompleted(tx: Db | Transaction, cardId: string, at: Date): Promise<void>` — completes the matching item in the active assignment (no-op when the card isn't in one) and flips the assignment to `completed` when nothing unfinished remains.

- [ ] **Step 1: Write the failing tests**

Append to `apps/backend/src/assignments/service.test.ts` (keep the existing imports and helpers; add the service import and the `assignmentItems` / `eq` imports as needed):

```ts
import { eq } from 'drizzle-orm'
import {
  expireStaleAssignments,
  listAssignments,
  loadActiveAssignment,
  markCardCompleted,
} from './service.ts'

async function seedAssignment(cardIds: string[], dueAt: Date) {
  const [row] = await conn!.db
    .insert(assignments)
    .values({ title: 'Условные предложения', dueAt, rationale: 'Сыпался на уроке.' })
    .returning()
  await conn!.db.insert(assignmentItems).values(
    cardIds.map((cardId, i) => ({
      assignmentId: row!.id,
      cardId,
      groupLabel: i === 0 ? 'Забытое' : 'Слова с урока',
      groupKind: i === 0 ? ('weak' as const) : ('new' as const),
      position: i,
    })),
  )
  return row!.id
}

describe.skipIf(noDb)('expireStaleAssignments', () => {
  test('flips an active assignment past its deadline to expired', async () => {
    const ids = await seedCards(3)
    const assignmentId = await seedAssignment(ids, new Date('2026-08-03T21:00:00.000Z'))

    await expireStaleAssignments(conn!.db, NOW)

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('expired')
  })

  test('leaves an assignment whose deadline is still ahead', async () => {
    const ids = await seedCards(3)
    await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))

    await expireStaleAssignments(conn!.db, NOW)

    const [row] = await conn!.db.select().from(assignments)
    expect(row!.status).toBe('active')
  })

  test('is idempotent', async () => {
    const ids = await seedCards(3)
    await seedAssignment(ids, new Date('2026-08-03T21:00:00.000Z'))
    await expireStaleAssignments(conn!.db, NOW)
    await expireStaleAssignments(conn!.db, NOW)
    const rows = await conn!.db.select().from(assignments)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('expired')
  })
})

describe.skipIf(noDb)('loadActiveAssignment', () => {
  test('returns null when nothing is active', async () => {
    const result = await loadActiveAssignment(conn!.db, NOW)
    expect(result.assignment).toBeNull()
    expect(result.items).toEqual([])
  })

  test('returns items ordered by position with grouped counts', async () => {
    const ids = await seedCards(3)
    await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))

    const result = await loadActiveAssignment(conn!.db, NOW)

    expect(result.assignment!.total).toBe(3)
    expect(result.assignment!.completed).toBe(0)
    expect(result.items.map((i) => i.position)).toEqual([0, 1, 2])
    expect(result.assignment!.groups).toEqual([
      { label: 'Забытое', kind: 'weak', total: 1, completed: 0 },
      { label: 'Слова с урока', kind: 'new', total: 2, completed: 0 },
    ])
  })

  test('excludes archived cards from items and from the denominator', async () => {
    const ids = await seedCards(3)
    await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))
    await conn!.db.update(cards).set({ status: 'archived' }).where(eq(cards.id, ids[0]!))

    const result = await loadActiveAssignment(conn!.db, NOW)

    expect(result.assignment!.total).toBe(2)
    expect(result.items).toHaveLength(2)
    expect(result.assignment!.groups.map((g) => g.label)).toEqual(['Слова с урока'])
  })

  test('expires a stale assignment rather than returning it', async () => {
    const ids = await seedCards(3)
    await seedAssignment(ids, new Date('2026-08-03T21:00:00.000Z'))
    const result = await loadActiveAssignment(conn!.db, NOW)
    expect(result.assignment).toBeNull()
  })
})

describe.skipIf(noDb)('markCardCompleted', () => {
  test('stamps completed_at on the matching item', async () => {
    const ids = await seedCards(3)
    const assignmentId = await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))

    await markCardCompleted(conn!.db, ids[0]!, NOW)

    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt).not.toBeNull()
    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('active')
  })

  test('does not overwrite an existing completed_at', async () => {
    const ids = await seedCards(3)
    await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))
    const first = new Date('2026-08-04T09:00:00.000Z')
    await markCardCompleted(conn!.db, ids[0]!, first)
    await markCardCompleted(conn!.db, ids[0]!, NOW)

    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt!.toISOString()).toBe(first.toISOString())
  })

  test('flips the assignment to completed once the last item is taken', async () => {
    const ids = await seedCards(3)
    const assignmentId = await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))

    for (const id of ids) await markCardCompleted(conn!.db, id, NOW)

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('completed')
    expect(row!.completedAt).not.toBeNull()
  })

  test('ignores cards that belong to no active assignment', async () => {
    const ids = await seedCards(3)
    await markCardCompleted(conn!.db, ids[0]!, NOW)
    const items = await conn!.db.select().from(assignmentItems)
    expect(items).toHaveLength(0)
  })

  test('archived items do not block completion', async () => {
    const ids = await seedCards(3)
    const assignmentId = await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))
    await conn!.db.update(cards).set({ status: 'archived' }).where(eq(cards.id, ids[2]!))

    await markCardCompleted(conn!.db, ids[0]!, NOW)
    await markCardCompleted(conn!.db, ids[1]!, NOW)

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('completed')
  })
})

describe.skipIf(noDb)('listAssignments', () => {
  test('returns newest first with progress counts', async () => {
    const ids = await seedCards(3)
    await conn!.db.insert(assignments).values({
      title: 'Старое',
      status: 'expired',
      dueAt: new Date('2026-07-30T21:00:00.000Z'),
      createdAt: new Date('2026-07-28T10:00:00.000Z'),
    })
    await seedAssignment(ids, new Date('2026-08-06T21:00:00.000Z'))
    await markCardCompleted(conn!.db, ids[0]!, NOW)

    const rows = await listAssignments(conn!.db, NOW)

    expect(rows).toHaveLength(2)
    expect(rows[0]!.title).toBe('Условные предложения')
    expect(rows[0]!.completed).toBe(1)
    expect(rows[0]!.total).toBe(3)
    expect(rows[1]!.title).toBe('Старое')
    expect(rows[1]!.total).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/backend && bun test src/assignments/service.test.ts`
Expected: FAIL — cannot resolve `./service.ts`.

- [ ] **Step 3: Extract the shared card mapper first**

Create `apps/backend/src/cards/dto.ts` by moving the private `toDueDto` function out of `apps/backend/src/cards/router.ts` (currently at line 438) **verbatim**, exported:

```ts
// Card → wire DTO for every read surface that hands a card to the practice
// screen: GET /cards/due and the assignment service both need the identical
// shape, so the mapper lives here rather than being copied.

import type { DueCardDto, FsrsCardState } from '@oxenfurt/shared'
import type { CardRow } from '../db/schema.ts'

export function toDueDto(row: CardRow, hasQuestions?: boolean): DueCardDto {
  // ... body moved verbatim from cards/router.ts, unchanged
}
```

Then in `cards/router.ts`, delete the local definition and add `import { toDueDto } from './dto.ts'`. Run `cd apps/backend && bun test src/cards/router.test.ts` — it must still pass unchanged, proving the move was behaviour-preserving.

- [ ] **Step 4: Write the service**

Create `apps/backend/src/assignments/service.ts` (it imports the mapper from Step 3 — do **not** redefine it here):

```ts
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
  DueCardDto,
  FsrsCardState,
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
```

Drop `DueCardDto` and `FsrsCardState` from this file's type imports — the mapper now lives in `../cards/dto.ts` and neither type is referenced here.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/backend && bun test src/assignments/service.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 6: Verify the mapper move broke nothing**

Run: `cd apps/backend && bun test && pnpm typecheck`
Expected: the full suite still passes — in particular every pre-existing `/cards/due` test, which now exercises the extracted mapper.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/cards/dto.ts apps/backend/src/cards/router.ts apps/backend/src/assignments/service.ts apps/backend/src/assignments/service.test.ts
git commit -m "feat(assignments): add lazy expiry, active load and completion accounting"
```

---

### Task 4: `POST /agent/assignments`

**Files:**
- Create: `apps/backend/src/assignments/router.ts`
- Create: `apps/backend/src/assignments/router.test.ts`

**Interfaces:**
- Consumes: `CreateAssignmentSchema`, `ASSIGNMENT_MAX_DUE_DAYS` from `@oxenfurt/shared`; `expireStaleAssignments` from `./service.ts`; `ingestTokenAuth` from `../middleware/ingest-token.ts`.
- Produces: `createAgentAssignmentsRouter(deps: { db: Db; ingestToken: string; now?: () => Date }): Hono` exposing `POST /`.

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/assignments/router.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { FsrsService } from '@oxenfurt/shared'
import { getTestDb, resetTestDb } from '../db/testing.ts'
import { assignmentItems, assignments, cards } from '../db/schema.ts'
import { ingestCards } from '../ingest/cards.ts'
import { createAgentAssignmentsRouter } from './router.ts'

const conn = await getTestDb()
const noDb = conn === null
const INGEST_TOKEN = 'test-ingest-token-assignments'
const NOW = new Date('2026-08-04T12:00:00.000Z')
const DUE = '2026-08-06T21:00:00.000Z'
const fsrs = new FsrsService({ enableFuzz: false })

beforeEach(async () => {
  if (conn) await resetTestDb(conn.db)
})

async function seedCards(count: number): Promise<string[]> {
  await ingestCards(
    conn!.db,
    fsrs,
    {
      cards: Array.from({ length: count }, (_, i) => ({
        type: 'vocab' as const,
        payload: {
          term: `term${i}`,
          translation: `перевод${i}`,
          context_sentence: `A sentence with term${i} inside.`,
          context_term_start: 14,
          context_term_end: 14 + `term${i}`.length,
        },
        source: 'lesson-2026-07-28',
      })),
    },
    NOW,
  )
  const rows = await conn!.db.select({ id: cards.id }).from(cards)
  return rows.map((r) => r.id)
}

function agentApp() {
  return createAgentAssignmentsRouter({ db: conn!.db, ingestToken: INGEST_TOKEN, now: () => NOW })
}

function body(cardIds: string[], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: 'Условные предложения и лексика 28 июля',
    rationale: 'Второй кондиционал сыпался весь урок.',
    due_at: DUE,
    source: 'lesson-2026-07-28',
    items: cardIds.map((card_id, i) => ({
      card_id,
      group_label: i === 0 ? 'Забытое' : 'Слова с урока',
      group_kind: i === 0 ? 'weak' : 'new',
    })),
    ...overrides,
  })
}

function post(cardIds: string[], overrides: Record<string, unknown> = {}, token = INGEST_TOKEN) {
  return agentApp().request('/', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body(cardIds, overrides),
  })
}

describe.skipIf(noDb)('POST /agent/assignments', () => {
  test('401 without the ingest token', async () => {
    const ids = await seedCards(3)
    const res = await post(ids, {}, 'wrong-token-wrong-token')
    expect(res.status).toBe(401)
  })

  test('creates an assignment with positioned items', async () => {
    const ids = await seedCards(3)
    const res = await post(ids)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ assignment_id: expect.any(String), items: 3 })

    const items = await conn!.db.select().from(assignmentItems)
    expect(items.map((i) => i.position).sort()).toEqual([0, 1, 2])
    expect(items.find((i) => i.cardId === ids[0])!.groupKind).toBe('weak')
  })

  test('400 invalid_payload when fewer than 3 items', async () => {
    const ids = await seedCards(3)
    const res = await post(ids.slice(0, 2))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_payload')
  })

  test('400 invalid_due_at when the deadline is in the past', async () => {
    const ids = await seedCards(3)
    const res = await post(ids, { due_at: '2026-08-03T21:00:00.000Z' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_due_at')
  })

  test('400 invalid_due_at when the deadline is more than 30 days out', async () => {
    const ids = await seedCards(3)
    const res = await post(ids, { due_at: '2026-09-10T21:00:00.000Z' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_due_at')
  })

  test('400 duplicate_cards when the same card appears twice', async () => {
    const ids = await seedCards(3)
    const res = await post([ids[0]!, ids[0]!, ids[1]!])
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('duplicate_cards')
  })

  test('400 unknown_cards listing ids that do not exist', async () => {
    const ids = await seedCards(3)
    const ghost = '99999999-9999-4999-8999-999999999999'
    const res = await post([ids[0]!, ids[1]!, ghost])
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('unknown_cards')
    expect(json.card_ids).toEqual([ghost])
  })

  test('400 unknown_cards when a card is archived', async () => {
    const ids = await seedCards(3)
    await conn!.db.update(cards).set({ status: 'archived' }).where(eq(cards.id, ids[2]!))
    const res = await post(ids)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('unknown_cards')
  })

  test('409 assignment_active when one is already live', async () => {
    const ids = await seedCards(3)
    await post(ids)
    const res = await post(ids)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('assignment_active')
  })

  test('replace:true expires the previous assignment', async () => {
    const ids = await seedCards(3)
    const first = await post(ids)
    const firstId = (await first.json()).assignment_id
    const res = await post(ids, { replace: true })
    expect(res.status).toBe(200)

    const [previous] = await conn!.db.select().from(assignments).where(eq(assignments.id, firstId))
    expect(previous!.status).toBe('expired')
    const live = await conn!.db.select().from(assignments).where(eq(assignments.status, 'active'))
    expect(live).toHaveLength(1)
  })

  test('an assignment past its deadline does not block a new one', async () => {
    const ids = await seedCards(3)
    await post(ids)
    await conn!.db
      .update(assignments)
      .set({ dueAt: new Date('2026-08-03T21:00:00.000Z') })
      .where(eq(assignments.status, 'active'))

    const res = await post(ids)
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/backend && bun test src/assignments/router.test.ts`
Expected: FAIL — cannot resolve `./router.ts`.

- [ ] **Step 3: Write the agent router**

Create `apps/backend/src/assignments/router.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/backend && bun test src/assignments/router.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Typecheck**

Run: `cd apps/backend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/assignments/router.ts apps/backend/src/assignments/router.test.ts
git commit -m "feat(assignments): add POST /agent/assignments with structural validation"
```

---

### Task 5: User read routes and server wiring

**Files:**
- Modify: `apps/backend/src/assignments/router.ts`
- Modify: `apps/backend/src/assignments/router.test.ts` (append)
- Modify: `apps/backend/src/server/app.ts:212-228`

**Interfaces:**
- Consumes: `loadActiveAssignment`, `listAssignments` from `./service.ts`; `jwtAuth` from `../middleware/auth.ts`.
- Produces: `createUserAssignmentsRouter(deps: { db: Db; jwtSecret: string; ingestToken: string; now?: () => Date }): Hono` exposing `GET /active` and `GET /`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/backend/src/assignments/router.test.ts` (add `signSession` and `createUserAssignmentsRouter` to the imports, plus a `JWT_SECRET` constant of at least 32 chars):

```ts
const JWT_SECRET = '0123456789abcdef0123456789abcdef-assign'

async function userHeader(): Promise<string> {
  const token = await signSession({ userId: 1 }, JWT_SECRET, { ttlSeconds: 900, now: NOW })
  return `Bearer ${token}`
}

function userApp() {
  return createUserAssignmentsRouter({
    db: conn!.db,
    jwtSecret: JWT_SECRET,
    ingestToken: INGEST_TOKEN,
    now: () => NOW,
  })
}

describe.skipIf(noDb)('GET /assignments/active', () => {
  test('401 without auth', async () => {
    const res = await userApp().request('/active')
    expect(res.status).toBe(401)
  })

  test('returns null when nothing is active', async () => {
    const res = await userApp().request('/active', { headers: { authorization: await userHeader() } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ assignment: null, items: [] })
  })

  test('returns the assignment with card DTOs and groups', async () => {
    const ids = await seedCards(3)
    await post(ids)

    const res = await userApp().request('/active', { headers: { authorization: await userHeader() } })
    const json = await res.json()

    expect(json.assignment.title).toBe('Условные предложения и лексика 28 июля')
    expect(json.assignment.total).toBe(3)
    expect(json.assignment.completed).toBe(0)
    expect(json.assignment.groups).toHaveLength(2)
    expect(json.items).toHaveLength(3)
    expect(json.items[0].card.id).toBe(ids[0])
    expect(json.items[0].card.fsrs.due).toBeString()
  })

  test('accepts the ingest token too', async () => {
    const ids = await seedCards(3)
    await post(ids)
    const res = await userApp().request('/active', {
      headers: { authorization: `Bearer ${INGEST_TOKEN}` },
    })
    expect(res.status).toBe(200)
  })
})

describe.skipIf(noDb)('GET /assignments', () => {
  test('lists history newest first', async () => {
    const ids = await seedCards(3)
    await post(ids)
    const res = await userApp().request('/', { headers: { authorization: await userHeader() } })
    const json = await res.json()
    expect(json.assignments).toHaveLength(1)
    expect(json.assignments[0].total).toBe(3)
    expect(json.assignments[0].status).toBe('active')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/backend && bun test src/assignments/router.test.ts`
Expected: FAIL — `createUserAssignmentsRouter` is not exported.

- [ ] **Step 3: Add the user router**

Append to `apps/backend/src/assignments/router.ts` (extend the existing imports with `jwtAuth` from `../middleware/auth.ts` and `listAssignments`, `loadActiveAssignment` from `./service.ts`):

```ts
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
```

- [ ] **Step 4: Mount both routers in the server**

In `apps/backend/src/server/app.ts`, add the import alongside the existing router imports:

```ts
import { createAgentAssignmentsRouter, createUserAssignmentsRouter } from '../assignments/router.ts'
```

and insert these mounts after the `/agent/questions` block (around line 228):

```ts
  app.route(
    '/assignments',
    createUserAssignmentsRouter({
      db: deps.db,
      jwtSecret: deps.jwtSecret,
      ingestToken: deps.ingestToken,
      now,
    }),
  )

  app.route(
    '/agent/assignments',
    createAgentAssignmentsRouter({
      db: deps.db,
      ingestToken: deps.ingestToken,
      now,
    }),
  )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/backend && bun test src/assignments/router.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 6: Run the full backend suite**

Run: `cd apps/backend && bun test`
Expected: PASS — no regressions in cards, questions, ingest, sessions, stats, app.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/assignments/router.ts apps/backend/src/assignments/router.test.ts apps/backend/src/server/app.ts
git commit -m "feat(assignments): add active + history read routes and mount routers"
```

---

### Task 6: `GET /agent/diagnostics`

**Files:**
- Create: `apps/backend/src/diagnostics/router.ts`
- Create: `apps/backend/src/diagnostics/router.test.ts`
- Modify: `apps/backend/src/server/app.ts`

**Interfaces:**
- Consumes: `DiagnosticsResponse`, `DiagnosticsCardDto` from `@oxenfurt/shared`; `expireStaleAssignments` from `../assignments/service.ts`.
- Produces: `createDiagnosticsRouter(deps: { db: Db; ingestToken: string; now?: () => Date }): Hono` exposing `GET /`.

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/diagnostics/router.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { FsrsService } from '@oxenfurt/shared'
import { getTestDb, resetTestDb } from '../db/testing.ts'
import { assignmentItems, assignments, cards } from '../db/schema.ts'
import { ingestCards } from '../ingest/cards.ts'
import { createDiagnosticsRouter } from './router.ts'

const conn = await getTestDb()
const noDb = conn === null
const INGEST_TOKEN = 'test-ingest-token-diagnostics'
const NOW = new Date('2026-08-04T12:00:00.000Z')
const fsrs = new FsrsService({ enableFuzz: false })

beforeEach(async () => {
  if (conn) await resetTestDb(conn.db)
})

async function seedCards(count: number, source = 'lesson-2026-07-28'): Promise<string[]> {
  await ingestCards(
    conn!.db,
    fsrs,
    {
      cards: Array.from({ length: count }, (_, i) => ({
        type: 'vocab' as const,
        payload: {
          term: `${source}-term${i}`,
          translation: `перевод${i}`,
          context_sentence: `A sentence with term${i} inside.`,
          context_term_start: 14,
          context_term_end: 20,
        },
        source,
      })),
    },
    NOW,
  )
  const rows = await conn!.db.select({ id: cards.id }).from(cards).where(eq(cards.source, source))
  return rows.map((r) => r.id)
}

function app() {
  return createDiagnosticsRouter({ db: conn!.db, ingestToken: INGEST_TOKEN, now: () => NOW })
}

function get() {
  return app().request('/', { headers: { authorization: `Bearer ${INGEST_TOKEN}` } })
}

describe.skipIf(noDb)('GET /agent/diagnostics', () => {
  test('401 without the ingest token', async () => {
    const res = await app().request('/', { headers: { authorization: 'Bearer nope-nope-nope' } })
    expect(res.status).toBe(401)
  })

  test('reports overdue cards with days_overdue', async () => {
    const ids = await seedCards(2)
    await conn!.db
      .update(cards)
      .set({ due: new Date('2026-07-28T12:00:00.000Z') })
      .where(eq(cards.id, ids[0]!))

    const json = (await (await get()).json())
    expect(json.summary.overdue).toBe(1)
    expect(json.overdue).toHaveLength(1)
    expect(json.overdue[0].card_id).toBe(ids[0])
    expect(json.overdue[0].days_overdue).toBe(7)
    expect(json.overdue[0].label).toBe('lesson-2026-07-28-term0')
  })

  test('reports leeches at four lapses or more', async () => {
    const ids = await seedCards(3)
    await conn!.db.update(cards).set({ lapses: 4 }).where(eq(cards.id, ids[0]!))
    await conn!.db.update(cards).set({ lapses: 3 }).where(eq(cards.id, ids[1]!))

    const json = await (await get()).json()
    expect(json.summary.leeches).toBe(1)
    expect(json.leeches.map((c: { card_id: string }) => c.card_id)).toEqual([ids[0]])
  })

  test('excludes archived cards everywhere', async () => {
    const ids = await seedCards(2)
    await conn!.db
      .update(cards)
      .set({ status: 'archived', lapses: 9, due: new Date('2026-07-01T12:00:00.000Z') })
      .where(eq(cards.id, ids[0]!))

    const json = await (await get()).json()
    expect(json.summary.active_cards).toBe(1)
    expect(json.overdue).toHaveLength(0)
    expect(json.leeches).toHaveLength(0)
  })

  test('groups recent sources with counts', async () => {
    await seedCards(2, 'lesson-2026-07-28')
    await seedCards(3, 'lesson-2026-08-01')

    const json = await (await get()).json()
    const labels = json.recent_sources.map((s: { source: string; cards: number }) => [s.source, s.cards])
    expect(labels).toContainEqual(['lesson-2026-07-28', 2])
    expect(labels).toContainEqual(['lesson-2026-08-01', 3])
  })

  test('last_assignment is null when none exists', async () => {
    const json = await (await get()).json()
    expect(json.last_assignment).toBeNull()
  })

  test('last_assignment reports unfinished cards of the newest assignment', async () => {
    const ids = await seedCards(3)
    const [row] = await conn!.db
      .insert(assignments)
      .values({ title: 'Пассивный залог', status: 'expired', dueAt: new Date('2026-08-01T21:00:00.000Z') })
      .returning()
    await conn!.db.insert(assignmentItems).values(
      ids.map((cardId, i) => ({
        assignmentId: row!.id,
        cardId,
        groupLabel: 'Тема',
        groupKind: 'topic' as const,
        position: i,
        completedAt: i === 0 ? NOW : null,
      })),
    )

    const json = await (await get()).json()
    expect(json.last_assignment.title).toBe('Пассивный залог')
    expect(json.last_assignment.status).toBe('expired')
    expect(json.last_assignment.completed).toBe(1)
    expect(json.last_assignment.total).toBe(3)
    expect(json.last_assignment.unfinished_card_ids.sort()).toEqual([ids[1], ids[2]].sort())
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/backend && bun test src/diagnostics/router.test.ts`
Expected: FAIL — cannot resolve `./router.ts`.

- [ ] **Step 3: Write the diagnostics router**

Create `apps/backend/src/diagnostics/router.ts`:

```ts
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
import { and, asc, count, desc, eq, gte, lte, sql } from 'drizzle-orm'
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
        deps.db
          .select()
          .from(cards)
          .where(and(eq(cards.status, 'active'), lte(cards.due, at)))
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
          .where(and(eq(cards.status, 'active'), lte(cards.due, at))),
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
```

- [ ] **Step 4: Mount the router**

In `apps/backend/src/server/app.ts`, add the import:

```ts
import { createDiagnosticsRouter } from '../diagnostics/router.ts'
```

and the mount, after the `/agent/assignments` block:

```ts
  app.route(
    '/agent/diagnostics',
    createDiagnosticsRouter({
      db: deps.db,
      ingestToken: deps.ingestToken,
      now,
    }),
  )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/backend && bun test src/diagnostics/router.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Typecheck and full suite**

Run: `cd apps/backend && pnpm typecheck && bun test`
Expected: no type errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/diagnostics apps/backend/src/server/app.ts
git commit -m "feat(assignments): expose agent-facing knowledge diagnostics"
```

---

### Task 7: Drill flag, completion hook on review, and archive settlement

**Files:**
- Modify: `apps/backend/src/assignments/service.ts`
- Modify: `apps/backend/src/cards/router.ts:255-352`
- Modify: `apps/backend/src/cards/router.test.ts` (append)

**Interfaces:**
- Consumes: `markCardCompleted` from `../assignments/service.ts`.
- Produces: `settleActiveAssignment(db: Queryable, at: Date): Promise<void>` — exported from `../assignments/service.ts`; flips the active assignment to `completed` when it has no unfinished non-archived items left. Extracted from the tail of `markCardCompleted` so both callers share one implementation.
- Produces: `applyReview(db, fsrs, cardId, rating, reviewedAt, opts?: { drill?: boolean })` — returns `FsrsCardState | null` as before; with `drill: true` it returns `null` for the FSRS state only when the card is missing, and otherwise skips all FSRS writes. `POST /cards/:id/review` accepts `{ rating, drill? }` and answers `{ fsrs: FsrsCardState | null, drill: boolean }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/backend/src/cards/router.test.ts` (reuse the file's existing helpers; add imports for `assignmentItems`, `assignments` and `cardReviews` if absent):

```ts
describe.skipIf(noDb)('POST /cards/:id/review — drill and assignment completion', () => {
  async function seedActiveAssignment(cardIds: string[]) {
    const [row] = await conn!.db
      .insert(assignments)
      .values({ title: 'Задание', dueAt: new Date('2026-08-06T21:00:00.000Z') })
      .returning()
    await conn!.db.insert(assignmentItems).values(
      cardIds.map((cardId, i) => ({
        assignmentId: row!.id,
        cardId,
        groupLabel: 'Тема',
        groupKind: 'topic' as const,
        position: i,
      })),
    )
    return row!.id
  }

  test('rating Good completes the matching assignment item', async () => {
    const ids = await seedManyCards(3)
    await seedActiveAssignment(ids)

    const res = await reviewRequest(ids[0]!, { rating: 3 })
    expect(res.status).toBe(200)

    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt).not.toBeNull()
  })

  test('rating Again leaves the item unfinished', async () => {
    const ids = await seedManyCards(3)
    await seedActiveAssignment(ids)

    await reviewRequest(ids[0]!, { rating: 1 })

    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt).toBeNull()
  })

  test('drill:true does not touch FSRS state or card_reviews', async () => {
    const ids = await seedManyCards(3)
    await seedActiveAssignment(ids)
    const [before] = await conn!.db.select().from(cards).where(eq(cards.id, ids[0]!))

    const res = await reviewRequest(ids[0]!, { rating: 3, drill: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ fsrs: null, drill: true })

    const [after] = await conn!.db.select().from(cards).where(eq(cards.id, ids[0]!))
    expect(after!.reps).toBe(before!.reps)
    expect(after!.due.toISOString()).toBe(before!.due.toISOString())
    const reviews = await conn!.db.select().from(cardReviews)
    expect(reviews).toHaveLength(0)
  })

  test('drill:true still completes the assignment item', async () => {
    const ids = await seedManyCards(3)
    await seedActiveAssignment(ids)

    await reviewRequest(ids[0]!, { rating: 3, drill: true })

    const [item] = await conn!.db
      .select()
      .from(assignmentItems)
      .where(eq(assignmentItems.cardId, ids[0]!))
    expect(item!.completedAt).not.toBeNull()
  })

  test('drill:false still writes FSRS state and a review row', async () => {
    const ids = await seedManyCards(3)
    const [before] = await conn!.db.select().from(cards).where(eq(cards.id, ids[0]!))

    await reviewRequest(ids[0]!, { rating: 3 })

    const [after] = await conn!.db.select().from(cards).where(eq(cards.id, ids[0]!))
    expect(after!.reps).toBe(before!.reps + 1)
    const reviews = await conn!.db.select().from(cardReviews)
    expect(reviews).toHaveLength(1)
  })

  test('completing the last item flips the assignment to completed', async () => {
    const ids = await seedManyCards(3)
    const assignmentId = await seedActiveAssignment(ids)

    for (const id of ids) await reviewRequest(id, { rating: 3 })

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('completed')
  })

  test('archiving the last unfinished card completes the assignment', async () => {
    const ids = await seedManyCards(3)
    const assignmentId = await seedActiveAssignment(ids)
    await reviewRequest(ids[0]!, { rating: 3 })
    await reviewRequest(ids[1]!, { rating: 3 })

    const res = await cardsApp().request(`/${ids[2]}/archive`, {
      method: 'POST',
      headers: { authorization: await authHeader() },
    })
    expect(res.status).toBe(200)

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('completed')
    expect(row!.completedAt).not.toBeNull()
  })

  test('archiving a card while others are unfinished leaves the assignment active', async () => {
    const ids = await seedManyCards(3)
    const assignmentId = await seedActiveAssignment(ids)

    await cardsApp().request(`/${ids[2]}/archive`, {
      method: 'POST',
      headers: { authorization: await authHeader() },
    })

    const [row] = await conn!.db.select().from(assignments).where(eq(assignments.id, assignmentId))
    expect(row!.status).toBe('active')
  })
})
```

These two tests close a gap the Task 3 review surfaced: without them, archiving the last unfinished card leaves the assignment `active` forever — it keeps occupying the Home screen at `2/2` and blocks new assignments with `409` until the deadline lapses. The spec explicitly calls the opposite behaviour correct: declining a card is a decision, not a skip.

Add these two helpers near the top of the file if equivalents don't already exist — `seedManyCards(n)` mirrors the seeding helper from `assignments/router.test.ts`, and:

```ts
async function reviewRequest(id: string, body: Record<string, unknown>) {
  return cardsApp().request(`/${id}/review`, {
    method: 'POST',
    headers: { authorization: await authHeader(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/backend && bun test src/cards/router.test.ts`
Expected: FAIL — `drill:true` still mutates FSRS and returns `{ fsrs: {...} }`; assignment items stay unfinished.

- [ ] **Step 3: Extract `settleActiveAssignment` in the service**

In `apps/backend/src/assignments/service.ts`, pull the "flip when nothing unfinished remains" tail out of `markCardCompleted` into an exported function, and have `markCardCompleted` call it. Behaviour must be identical — this is a pure extraction, and the Task 3 service tests must still pass untouched.

```ts
/**
 * Completes the active assignment when it has no unfinished, non-archived
 * items left. Called from two places: after a card is taken (rating ≥ Good)
 * and after a card is archived. Archiving the last owed card settles the
 * assignment rather than stranding it — declining a card is a decision, not
 * a skip, and a stuck 'active' row would hold the Home screen and block new
 * assignments with 409 until the deadline lapsed.
 */
export async function settleActiveAssignment(db: Queryable, at: Date): Promise<void> {
  const [active] = await db.select().from(assignments).where(eq(assignments.status, 'active'))
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
```

An assignment whose every item has been archived settles as `completed` too — there is nothing left to owe.

- [ ] **Step 4: Call it from the archive route**

In `apps/backend/src/cards/router.ts`, the existing `app.post('/:id/archive', …)` route (line 255) archives the card and returns. After the archive succeeds and before the response, add:

```ts
    await settleActiveAssignment(deps.db, now())
```

- [ ] **Step 5: Extend `applyReview`**

In `apps/backend/src/cards/router.ts`, add the import:

```ts
import { markCardCompleted, settleActiveAssignment } from '../assignments/service.ts'
```

and replace the `applyReview` signature and body with:

```ts
export interface ApplyReviewOptions {
  /** Repeat of a card already measured today. Moves assignment progress
   *  but writes nothing to FSRS — cramming is study, not measurement.
   *  Without this, every in-session repeat lands as another review with a
   *  near-zero interval and steadily corrupts the scheduler. */
  drill?: boolean
}

export async function applyReview(
  db: Db,
  fsrs: FsrsService,
  cardId: string,
  rating: Rating,
  reviewedAt: Date,
  opts: ApplyReviewOptions = {},
): Promise<FsrsCardState | null> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(cards)
      .where(eq(cards.id, cardId))
      .for('update')
    if (row === undefined || row.status !== 'active') return null

    if (rating >= 3) {
      await markCardCompleted(tx, cardId, reviewedAt)
    }

    if (opts.drill === true) return null

    // ... existing body unchanged from `const before: FsrsCardState = {` onward
  })
}
```

Keep everything from `const before: FsrsCardState = {` to `return next` exactly as it is today — only the guard clauses above are new.

- [ ] **Step 6: Extend the route**

Replace the body-parsing and dispatch part of `app.post('/:id/review', …)` with:

```ts
    const parsed = v.safeParse(
      v.object({ rating: RatingSchema, drill: v.optional(v.boolean(), false) }),
      body,
    )
    if (!parsed.success) {
      return c.json({ error: 'invalid_rating' }, 400)
    }

    const reviewedAt = now()
    const drill = parsed.output.drill
    const updated = await applyReview(deps.db, deps.fsrs, id, parsed.output.rating, reviewedAt, {
      drill,
    })
    // A drill never produces FSRS state, so `null` there is success — only a
    // non-drill null means the card is gone or archived.
    if (updated === null && !drill) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json({ fsrs: updated, drill })
```

Note the behavioural subtlety this introduces: a drill against a missing or archived card now answers `200 { fsrs: null, drill: true }` instead of 404. That is acceptable — the client only drills cards it already holds in its queue — and keeps the transaction from needing a second existence probe.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/backend && bun test src/cards/router.test.ts`
Expected: PASS — including the 6 new tests and all pre-existing review tests (`{ fsrs: … }` responses now also carry `drill: false`; update any existing assertion that used `toEqual` on the whole response body).

- [ ] **Step 8: Full suite and typecheck**

Run: `cd apps/backend && pnpm typecheck && bun test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/cards/router.ts apps/backend/src/cards/router.test.ts apps/backend/src/assignments/service.ts
git commit -m "feat(assignments): add drill reviews and completion on rating or archive"
```

---

### Task 8: Mini-app data layer and pure helpers

**Files:**
- Create: `apps/mini-app/src/hooks/useActiveAssignment.ts`
- Create: `apps/mini-app/src/components/assignmentHelpers.ts`
- Create: `apps/mini-app/src/components/assignmentHelpers.test.ts`

**Interfaces:**
- Consumes: `ActiveAssignmentResponse`, `AssignmentDto`, `AssignmentItemDto` from `@oxenfurt/shared`; `fetchWithAuth` from `../lib/api`.
- Produces:
  - `useActiveAssignment(): UseQueryResult<ActiveAssignmentResponse>` — query key `['assignments', 'active']`, 30 s refetch.
  - `buildAssignmentQueue(items: AssignmentItemDto[]): DueCardDto[]`
  - `isDrillRepeat(card: DueCardDto, answeredThisSession: ReadonlySet<string>, now: Date): boolean`
  - `deadlineState(dueAt: string, now: Date): { days: number; urgent: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `apps/mini-app/src/components/assignmentHelpers.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { AssignmentItemDto, DueCardDto } from '@oxenfurt/shared';
import { buildAssignmentQueue, deadlineState, isDrillRepeat } from './assignmentHelpers';

const NOW = new Date('2026-08-04T12:00:00.000Z');

function card(id: string, lastReview: string | null = null): DueCardDto {
  return {
    id,
    type: 'vocab',
    payload: {
      term: id,
      translation: 'перевод',
      context_sentence: 'A sentence.',
      context_term_start: 0,
      context_term_end: 1,
    },
    source: null,
    source_quote: null,
    fsrs: {
      fsrs_state: 2,
      due: '2026-08-04T00:00:00.000Z',
      stability: 4,
      difficulty: 6,
      elapsed_days: 1,
      scheduled_days: 2,
      learning_steps: 0,
      reps: 3,
      lapses: 1,
      last_review: lastReview,
    },
  };
}

function item(id: string, position: number, completed: boolean): AssignmentItemDto {
  return {
    card: card(id),
    group_label: 'Тема',
    group_kind: 'topic',
    position,
    completed_at: completed ? '2026-08-04T09:00:00.000Z' : null,
  };
}

describe('buildAssignmentQueue', () => {
  test('keeps position order', () => {
    const queue = buildAssignmentQueue([item('c', 2, false), item('a', 0, false), item('b', 1, false)]);
    expect(queue.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  test('drops already-completed items', () => {
    const queue = buildAssignmentQueue([item('a', 0, true), item('b', 1, false)]);
    expect(queue.map((c) => c.id)).toEqual(['b']);
  });

  test('returns an empty queue when everything is done', () => {
    expect(buildAssignmentQueue([item('a', 0, true)])).toEqual([]);
  });
});

describe('isDrillRepeat', () => {
  test('false on the first answer of a card never reviewed', () => {
    expect(isDrillRepeat(card('a', null), new Set(), NOW)).toBe(false);
  });

  test('true when the card was already answered this session', () => {
    expect(isDrillRepeat(card('a', null), new Set(['a']), NOW)).toBe(true);
  });

  test('true when the card was last reviewed earlier today', () => {
    expect(isDrillRepeat(card('a', '2026-08-04T07:30:00.000Z'), new Set(), NOW)).toBe(true);
  });

  test('false when the card was last reviewed yesterday', () => {
    expect(isDrillRepeat(card('a', '2026-08-03T23:00:00.000Z'), new Set(), NOW)).toBe(false);
  });
});

describe('deadlineState', () => {
  test('counts whole days remaining', () => {
    expect(deadlineState('2026-08-06T21:00:00.000Z', NOW)).toEqual({ days: 2, urgent: false });
  });

  test('marks the final day urgent', () => {
    expect(deadlineState('2026-08-04T21:00:00.000Z', NOW)).toEqual({ days: 0, urgent: true });
  });

  test('clamps a passed deadline to zero', () => {
    expect(deadlineState('2026-08-03T21:00:00.000Z', NOW)).toEqual({ days: 0, urgent: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/mini-app && bun test src/components/assignmentHelpers.test.ts`
Expected: FAIL — cannot resolve `./assignmentHelpers`.

- [ ] **Step 3: Write the helpers**

Create `apps/mini-app/src/components/assignmentHelpers.ts`:

```ts
// Pure helpers for the assignment flow, kept out of the React tree so the
// two decisions that are easy to get wrong — queue composition and the
// drill flag — are unit-testable. Same rationale as practiceHelpers.ts.

import type { AssignmentItemDto, DueCardDto } from '@oxenfurt/shared';

/** Cards still owed, in the order the agent laid them out. Completed items
 *  never re-enter the queue — the assignment is a to-do list, not a deck. */
export function buildAssignmentQueue(items: AssignmentItemDto[]): DueCardDto[] {
  return [...items]
    .filter((item) => item.completed_at === null)
    .sort((a, b) => a.position - b.position)
    .map((item) => item.card);
}

/**
 * True when this answer is a repeat rather than a measurement.
 *
 * The first answer per card per day is the honest FSRS signal; everything
 * after it in the same day is cramming and must not be written to the
 * scheduler. Two sources say "already measured today": the in-session set of
 * cards the user has answered, and `last_review` landing on today's local
 * date (the user closed the app and came back).
 */
export function isDrillRepeat(
  card: DueCardDto,
  answeredThisSession: ReadonlySet<string>,
  now: Date,
): boolean {
  if (answeredThisSession.has(card.id)) return true;
  const last = card.fsrs.last_review;
  if (last === null) return false;
  return isSameLocalDay(new Date(last), now);
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Whole days left before the deadline, and whether we're inside the final
 *  day. `urgent` is the ONLY escalation the UI is allowed — no red, no
 *  counters, no nagging. */
export function deadlineState(dueAt: string, now: Date): { days: number; urgent: boolean } {
  const ms = new Date(dueAt).getTime() - now.getTime();
  const days = Math.max(0, Math.floor(ms / 86_400_000));
  return { days, urgent: days === 0 };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/mini-app && bun test src/components/assignmentHelpers.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Write the query hook**

Create `apps/mini-app/src/hooks/useActiveAssignment.ts`:

```ts
// Single source of truth for "is there an assignment right now". Home and
// PracticeSession both read it; the 30 s refetch matches the /stats/today
// cadence already used on Home so the two never disagree for long.

import { useQuery } from '@tanstack/react-query';
import type { ActiveAssignmentResponse } from '@oxenfurt/shared';
import { fetchWithAuth } from '../lib/api';

export const ACTIVE_ASSIGNMENT_KEY = ['assignments', 'active'] as const;

export function useActiveAssignment() {
  return useQuery({
    queryKey: ACTIVE_ASSIGNMENT_KEY,
    queryFn: async (): Promise<ActiveAssignmentResponse> => {
      const res = await fetchWithAuth('/assignments/active');
      if (!res.ok) throw new Error('Failed to fetch assignment');
      return (await res.json()) as ActiveAssignmentResponse;
    },
    refetchInterval: 30_000,
  });
}
```

- [ ] **Step 6: Typecheck**

Run: `cd apps/mini-app && pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/mini-app/src/hooks/useActiveAssignment.ts apps/mini-app/src/components/assignmentHelpers.ts apps/mini-app/src/components/assignmentHelpers.test.ts
git commit -m "feat(assignments): add mini-app assignment query hook and pure helpers"
```

---

### Task 9: Home screen — variant C

**Files:**
- Create: `apps/mini-app/src/components/AssignmentCard.tsx`
- Modify: `apps/mini-app/src/components/Home.tsx:106-115, 192-290`
- Modify: `apps/mini-app/src/lib/i18n/locales/ru.ts`
- Modify: `apps/mini-app/src/lib/i18n/locales/en.ts`

**Interfaces:**
- Consumes: `useActiveAssignment` (Task 8), `deadlineState` (Task 8), `AssignmentDto`.
- Produces: `AssignmentCard({ assignment, onOpenRationale }: { assignment: AssignmentDto; onOpenRationale: () => void })` — the title, deadline line and group breakdown that sit under the ring. `Home` gains an `onStartAssignment: () => void` prop.

- [ ] **Step 1: Add the i18n keys**

Append to `apps/mini-app/src/lib/i18n/locales/ru.ts`:

```ts
  // --- Assignments ---
  'assignment.from_agent': '📓 Hermes',
  'assignment.ring_label': 'Задание',
  'assignment.due_days': 'сдать через {days} дн.',
  'assignment.due_today': 'сдать сегодня',
  'assignment.continue': 'Продолжить задание',
  'assignment.free_practice': 'Свободная практика',
  'assignment.group_topic': 'Тема',
  'assignment.group_new': 'Новое',
  'assignment.group_weak': 'Забытое',
  'assignment.rationale_title': 'Почему это задание',
  'assignment.progress': '{completed} из {total}',
  'assignment.done_title': 'Задание сдано',
  'assignment.done_desc': 'Hermes соберёт следующее после занятия.',
  'assignment.history_title': 'История заданий',
  'assignment.history_empty': 'Заданий пока не было',
  'assignment.status_active': 'В работе',
  'assignment.status_completed': 'Сдано',
  'assignment.status_expired': 'Просрочено',
```

Add the matching English entries to `apps/mini-app/src/lib/i18n/locales/en.ts`:

```ts
  // --- Assignments ---
  'assignment.from_agent': '📓 Hermes',
  'assignment.ring_label': 'Assignment',
  'assignment.due_days': 'due in {days}d',
  'assignment.due_today': 'due today',
  'assignment.continue': 'Continue assignment',
  'assignment.free_practice': 'Free practice',
  'assignment.group_topic': 'Topic',
  'assignment.group_new': 'New',
  'assignment.group_weak': 'Forgotten',
  'assignment.rationale_title': 'Why this assignment',
  'assignment.progress': '{completed} of {total}',
  'assignment.done_title': 'Assignment submitted',
  'assignment.done_desc': 'Hermes will build the next one after your lesson.',
  'assignment.history_title': 'Assignment history',
  'assignment.history_empty': 'No assignments yet',
  'assignment.status_active': 'In progress',
  'assignment.status_completed': 'Done',
  'assignment.status_expired': 'Missed',
```

- [ ] **Step 2: Write the AssignmentCard component**

Create `apps/mini-app/src/components/AssignmentCard.tsx`:

```tsx
// The block under the ring on Home. Answers "why exactly this, today" —
// without the group breakdown an assignment reads as a random pile and the
// agent's judgement is invisible.

import type { AssignmentDto } from '@oxenfurt/shared';
import { deadlineState } from './assignmentHelpers';
import { useT } from '../lib/i18n/useT';

interface AssignmentCardProps {
  assignment: AssignmentDto;
  onOpenRationale: () => void;
}

export function AssignmentCard({ assignment, onOpenRationale }: AssignmentCardProps) {
  const t = useT();
  const { days, urgent } = deadlineState(assignment.due_at, new Date());

  return (
    <div className="w-full max-w-[340px] flex flex-col items-center gap-3">
      <button
        onClick={onOpenRationale}
        disabled={assignment.rationale === null}
        className="text-center px-2 active:opacity-70 transition-opacity disabled:active:opacity-100"
      >
        <h2 className="text-[13px] font-black tracking-tight leading-snug text-app-text">
          {assignment.title}
        </h2>
        <p
          className={`text-[10px] font-bold uppercase tracking-wider mt-1.5 ${
            urgent ? 'text-orange-400' : 'text-app-hint opacity-70'
          }`}
        >
          {t('assignment.from_agent')} ·{' '}
          {urgent ? t('assignment.due_today') : t('assignment.due_days', { days: String(days) })}
        </p>
      </button>

      <div className="w-full flex flex-col gap-1.5 px-1">
        {assignment.groups.map((group) => (
          <div key={group.label} className="flex items-center gap-2.5 text-[11px]">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                group.kind === 'weak' ? 'bg-orange-400' : 'bg-app-primary'
              }`}
            />
            <span className="flex-1 text-app-text/85 truncate">{group.label}</span>
            <span className="text-app-hint/70 font-black text-[10px] tabular-nums">
              {group.completed}/{group.total}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire Home to the assignment**

In `apps/mini-app/src/components/Home.tsx`:

1. Add the imports:

```tsx
import { AssignmentCard } from './AssignmentCard';
import { useActiveAssignment } from '../hooks/useActiveAssignment';
```

2. Add `onStartAssignment: () => void` to `HomeProps` and destructure it.

3. Inside the component, after the existing `stats` query:

```tsx
  const { data: assignmentData } = useActiveAssignment();
  const assignment = assignmentData?.assignment ?? null;
  const [isRationaleOpen, setIsRationaleOpen] = useState(false);
```

4. Replace the ring's numeric source so the assignment drives it when present. Change the derived values block (currently lines 106-114) to:

```tsx
  const due = stats?.dueCount ?? 0;
  const reviewed = stats?.reviewedToday ?? 0;
  const totalForToday = due + reviewed;

  // The ring belongs to whatever is currently the primary loop: the
  // assignment when one is live, today's queue otherwise.
  const ringDone = assignment ? assignment.completed : reviewed;
  const ringTotal = assignment ? assignment.total : totalForToday;

  const progressPercent =
    ringTotal > 0 ? (ringDone / ringTotal) * 100 : ringDone > 0 ? 100 : 0;
```

5. Inside the ring's centre `<div>` (currently the `due > 0 ? … : reviewed > 0 ? … : …` ternary at lines 226-267), add a leading branch:

```tsx
            {assignment ? (
              <>
                <span className="font-black text-app-text tracking-tighter leading-none text-5xl">
                  {ringDone}
                  <span className="text-2xl opacity-40">/{ringTotal}</span>
                </span>
                <div className="h-4 flex items-center mt-3">
                  <span className="text-[10px] font-black uppercase tracking-[0.2em] text-app-hint opacity-60 leading-none">
                    {t('assignment.ring_label')}
                  </span>
                </div>
              </>
            ) : due > 0 ? (
```

leaving the existing `due > 0` / `reviewed > 0` / empty branches untouched below it.

6. Under the ring, replace the status-pill block (the `stats.learnedCount === 0 …` ternary at lines 272-288) with a conditional: when `assignment` is non-null render `<AssignmentCard assignment={assignment} onOpenRationale={() => setIsRationaleOpen(true)} />`; otherwise render the existing pill unchanged.

7. Change the Telegram MainButton effect (lines 116-140) so that when an assignment is live the button reads `t('assignment.continue')` and calls `onStartAssignment()` instead of `onStart(mode)`. Keep the existing paused-session branch ahead of both — a paused free session still resumes first.

8. Add a secondary button beneath the existing action list, rendered only when `assignment` is non-null:

```tsx
              <button
                onClick={() => onStart(mode)}
                className="flex items-center justify-center gap-2 bg-app-surface border border-app-border rounded-2xl px-4 py-3 text-[11px] font-bold text-app-hint active:scale-[0.98] transition-transform"
              >
                {t('assignment.free_practice')}
              </button>
```

9. Render the rationale in the existing `BottomSheet` component, titled `t('assignment.rationale_title')`, body `<Markdown>{assignment.rationale}</Markdown>`, open state `isRationaleOpen`.

- [ ] **Step 4: Verify the empty path is untouched**

Run: `cd apps/mini-app && pnpm typecheck && pnpm lint`
Expected: no errors. Manually confirm by reading the diff that when `assignment === null` every branch resolves to the pre-existing markup.

- [ ] **Step 5: Run the mini-app tests**

Run: `cd apps/mini-app && bun test`
Expected: PASS — existing `practiceHelpers.test.ts` and `heatmap.test.ts` plus the new `assignmentHelpers.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/mini-app/src/components/AssignmentCard.tsx apps/mini-app/src/components/Home.tsx apps/mini-app/src/lib/i18n/locales
git commit -m "feat(assignments): make the active assignment the primary Home screen"
```

---

### Task 10: Assignment practice session

**Files:**
- Modify: `apps/mini-app/src/components/PracticeSession.tsx:48-105, 173-181, 384-425`
- Modify: `apps/mini-app/src/App.tsx`

**Interfaces:**
- Consumes: `useActiveAssignment`, `buildAssignmentQueue`, `isDrillRepeat` (Task 8); the `drill` field on `POST /cards/:id/review` (Task 7).
- Produces: `PracticeSession` accepts a new optional prop `assignmentMode?: boolean`. `App` passes `assignmentMode` when the user started from the assignment button.

- [ ] **Step 1: Add the prop and the queue source**

In `apps/mini-app/src/components/PracticeSession.tsx`, first add the imports (extend the existing `@tanstack/react-query` import with `useQueryClient`):

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ACTIVE_ASSIGNMENT_KEY, useActiveAssignment } from '../hooks/useActiveAssignment';
import { buildAssignmentQueue, isDrillRepeat } from './assignmentHelpers';
```

then:

1. Extend the props:

```tsx
interface PracticeSessionProps {
  mode: PracticeMode;
  /** Session driven by the active assignment rather than the FSRS due
   *  queue. Changes three things: where cards come from, that failed cards
   *  always re-queue, and that repeats are sent as drills. */
  assignmentMode?: boolean;
  onComplete: (total: number, correct: number) => void;
  onExit: () => void;
}
```

2. Add the assignment query next to the existing `/due` query, and make each disable the other:

```tsx
  const assignmentQuery = useActiveAssignment();
  const assignmentCards = useMemo(
    () => (assignmentMode ? buildAssignmentQueue(assignmentQuery.data?.items ?? []) : []),
    [assignmentMode, assignmentQuery.data?.items],
  );
```

Set `enabled: !hasResumedSession && !assignmentMode` on the existing `useQuery` for `/cards/due` so an assignment session never fetches the due queue.

3. Feed `baseCards` from the right source — replace the `const all = data?.cards ?? []` line inside the `baseCards` memo with:

```tsx
    const all = assignmentMode ? assignmentCards : (data?.cards ?? []);
```

and add `assignmentMode` and `assignmentCards` to that memo's dependency array.

- [ ] **Step 2: Always re-queue failures in assignment mode**

Change the replay gate (currently line 389) from:

```tsx
    if (rating === RATING.Again && getSettings().inSessionReplay) {
```

to:

```tsx
    // In an assignment, re-queueing a failed card isn't a preference — the
    // item stays owed until it's taken, so showing it again in the same
    // sitting is the whole mechanic.
    if (rating === RATING.Again && (assignmentMode || getSettings().inSessionReplay)) {
```

- [ ] **Step 3: Send the drill flag**

1. Track what's already been answered this session, next to the other refs:

```tsx
  const answeredThisSession = useRef<Set<string>>(new Set());
```

2. Extend the mutation:

```tsx
  const reviewMutation = useMutation({
    mutationFn: async ({ id, rating, drill }: { id: string; rating: Rating; drill: boolean }) => {
      const res = await fetchWithAuth(`/cards/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ rating, drill }),
      });
      if (!res.ok) throw new Error('Failed to submit review');
      return res.json();
    },
  });
```

3. At the top of `handleRate`, before the pending-review bookkeeping, compute and record the flag:

```tsx
    const drill = isDrillRepeat(currentCard, answeredThisSession.current, new Date());
    answeredThisSession.current.add(currentCard.id);
```

4. Stash `drill` on the `PendingReview` object (add `drill: boolean` to the `PendingReview` interface in `apps/mini-app/src/hooks/usePracticeQueue.ts`) and pass it through at every `reviewMutation.mutate(...)` call site — the three inside `PracticeSession` (lines ~397, ~402, ~423) and the unmount flush (line ~238).

- [ ] **Step 4: Invalidate the assignment query after a rating**

Add near the mutation definition:

```tsx
  const queryClient = useQueryClient();
```

and in the mutation's `onSuccess`:

```tsx
    onSuccess: () => {
      if (assignmentMode) void queryClient.invalidateQueries({ queryKey: ACTIVE_ASSIGNMENT_KEY });
    },
```

so Home's ring and the group counters are correct the moment the user backs out.

- [ ] **Step 5: Wire App**

In `apps/mini-app/src/App.tsx`:

1. Add state: `const [assignmentMode, setAssignmentMode] = useState(false);`
2. Pass `onStartAssignment={() => { setAssignmentMode(true); setScreen('practice'); }}` to `<Home />`, and make the existing free-practice `onStart` set `setAssignmentMode(false)` first.
3. Pass `assignmentMode={assignmentMode}` to `<PracticeSession />`.

- [ ] **Step 6: Typecheck, lint and test**

Run: `cd apps/mini-app && pnpm typecheck && pnpm lint && bun test`
Expected: all green.

- [ ] **Step 7: Manual smoke test**

Start the backend and mini-app dev servers, seed an assignment with:

```bash
curl -s -X POST http://127.0.0.1:3000/agent/assignments \
  -H "Authorization: Bearer $OXENFURT_INGEST_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"Тестовое задание","due_at":"2026-08-10T21:00:00.000Z","items":[…3 real card ids…]}'
```

Confirm: Home shows the ring as `0/3` with the group breakdown; the MainButton reads «Продолжить задание»; rating Good three times flips the screen back to the free-practice layout; rating Again re-shows the card in the same sitting and the second answer posts `drill: true` (check the network tab).

- [ ] **Step 8: Commit**

```bash
git add apps/mini-app/src/components/PracticeSession.tsx apps/mini-app/src/hooks/usePracticeQueue.ts apps/mini-app/src/App.tsx
git commit -m "feat(assignments): drive practice sessions from the active assignment"
```

---

### Task 11: Assignment history

**Files:**
- Create: `apps/mini-app/src/components/AssignmentHistory.tsx`
- Modify: `apps/mini-app/src/components/Home.tsx`

**Interfaces:**
- Consumes: `AssignmentListItemDto` from `@oxenfurt/shared`; `BottomSheet` from `./BottomSheet`; the i18n keys added in Task 9.
- Produces: `AssignmentHistory({ isOpen, onClose }: { isOpen: boolean; onClose: () => void })`.

- [ ] **Step 1: Write the component**

Create `apps/mini-app/src/components/AssignmentHistory.tsx`:

```tsx
// The artifact side of assignments: what was set, what was actually taken.
// This is what gets opened in front of the tutor at the next lesson, which
// is why expired rows show their real numbers instead of being hidden.

import { useQuery } from '@tanstack/react-query';
import type { AssignmentListItemDto } from '@oxenfurt/shared';
import { fetchWithAuth } from '../lib/api';
import { BottomSheet } from './BottomSheet';
import { useT } from '../lib/i18n/useT';

interface AssignmentHistoryProps {
  isOpen: boolean;
  onClose: () => void;
}

const STATUS_KEY = {
  active: 'assignment.status_active',
  completed: 'assignment.status_completed',
  expired: 'assignment.status_expired',
} as const;

export function AssignmentHistory({ isOpen, onClose }: AssignmentHistoryProps) {
  const t = useT();
  const { data } = useQuery({
    queryKey: ['assignments', 'history'],
    enabled: isOpen,
    queryFn: async () => {
      const res = await fetchWithAuth('/assignments');
      if (!res.ok) throw new Error('Failed to fetch assignments');
      return (await res.json()) as { assignments: AssignmentListItemDto[] };
    },
  });

  const rows = data?.assignments ?? [];

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={t('assignment.history_title')}>
      {rows.length === 0 ? (
        <p className="text-center text-app-hint text-xs py-8">{t('assignment.history_empty')}</p>
      ) : (
        <div className="flex flex-col gap-2 pb-4">
          {rows.map((row) => (
            <div
              key={row.id}
              className="bg-app-surface border border-app-border rounded-2xl px-4 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="text-[12px] font-bold text-app-text leading-snug flex-1">
                  {row.title}
                </span>
                <span className="text-[9px] font-black uppercase tracking-wider text-app-hint/70 shrink-0 pt-0.5">
                  {t(STATUS_KEY[row.status])}
                </span>
              </div>
              <div className="flex items-center justify-between mt-2 text-[10px] text-app-hint/70">
                <span className="tabular-nums">
                  {t('assignment.progress', {
                    completed: String(row.completed),
                    total: String(row.total),
                  })}
                </span>
                <span>{new Date(row.due_at).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </BottomSheet>
  );
}
```

Before writing this, open `apps/mini-app/src/components/BottomSheet.tsx` and match its actual prop names — if it takes `open` / `onOpenChange` rather than `isOpen` / `onClose`, adapt the call site rather than changing BottomSheet.

- [ ] **Step 2: Open it from Home**

In `Home.tsx`, add `const [isHistoryOpen, setIsHistoryOpen] = useState(false);`, render `<AssignmentHistory isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} />`, and trigger it from a small button in the header row next to the settings gear (use the `History` icon from `lucide-react`, same styling as the existing settings button).

- [ ] **Step 3: Typecheck, lint and test**

Run: `cd apps/mini-app && pnpm typecheck && pnpm lint && bun test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add apps/mini-app/src/components/AssignmentHistory.tsx apps/mini-app/src/components/Home.tsx
git commit -m "feat(assignments): add assignment history sheet"
```

---

### Task 12: Hermes skill and documentation

**Files:**
- Create: `deploy/hermes/skills/oxenfurt_assignments.md`
- Modify: `README.md` (the "Agent Integration" section)

**Interfaces:**
- Consumes: the endpoints from Tasks 4, 5 and 6.
- Produces: documentation only. No code.

- [ ] **Step 1: Write the skill**

Create `deploy/hermes/skills/oxenfurt_assignments.md` following the structure of the two existing skills (Purpose / Endpoints / Payload schema / Rules / Full example / Error handling / What this skill does NOT do). It must state:

- **Trigger.** Run immediately after `oxenfurt_ingest` completes for a lesson, while the transcript is still in context. Also run on the regular poll if `GET /assignments/active` returns `null` and more than 48 h have passed since the last assignment's `created_at`.
- **Read the diagnostics first.** `GET /agent/diagnostics` returns `overdue`, `leeches`, `fragile`, `recent_sources` and `last_assignment`. Explain each field: `days_overdue` is schedule debt, `lapses` is repeated forgetting, low `stability` with high `difficulty` means the card is about to lapse again.
- **Composition.** Target ~20 items even though 30 are allowed — the learner's stated failure mode is bouncing off large piles. Compose from three kinds and label each item accordingly: `new` (vocabulary and rules from the lesson just processed), `topic` (the thing the learner visibly struggled with in the transcript), `weak` (leeches and fragile cards from diagnostics). Items in `last_assignment.unfinished_card_ids` go in first, before anything else.
- **Deadline.** `due_at` should be the day before the next scheduled lesson. If the schedule is unknown, use three days out. Never more than 30 days — the backend rejects it.
- **Voice.** `title` is concrete and human («Условные предложения и лексика 28 июля»), never generic («Задание №4»). `rationale` is two or three sentences in the tutor's voice explaining the selection, rendered as Markdown in the Mini App.
- **Single active assignment.** Creating one while another is live returns `409 assignment_active`. Do NOT retry with `replace: true` automatically — an unfinished assignment is information, not an obstacle. Replace only when the learner asks for a new one.
- **Notifications.** On successful creation, send exactly one Telegram message with an inline `web_app` button. Send at most one reminder, no earlier than 24 h before `due_at`, and only if the assignment is still active and incomplete. Nothing else — the app itself never nags, and that is deliberate.
- **Error table** mirroring the existing skills: `400 invalid_payload` (log `issues`), `400 invalid_due_at`, `400 unknown_cards` (drop the listed ids and retry once), `400 duplicate_cards`, `409 assignment_active`, `401`, `500`.
- **What this skill does NOT do:** create cards (that's `oxenfurt_ingest`), compute FSRS state, mark items complete, or delete assignments.

- [ ] **Step 2: Update the README**

In the "📡 Agent Integration" section of `README.md`, add the two new spec links beneath the existing ones:

```markdown
- **Assignment Spec**: [`deploy/hermes/skills/oxenfurt_assignments.md`](deploy/hermes/skills/oxenfurt_assignments.md)
```

and add a sentence to the feature list describing assignments: the agent composes a bounded, deadline-bound set of cards after each lesson, and that assignment becomes the app's primary screen while free practice stays available.

- [ ] **Step 3: Verify every documented endpoint exists**

Run: `cd apps/backend && grep -rn "agent/assignments\|agent/diagnostics\|'/assignments'" src/server/app.ts`
Expected: all three mounts present.

- [ ] **Step 4: Full repository check**

Run: `pnpm typecheck && pnpm test`
Expected: all packages green.

- [ ] **Step 5: Commit**

```bash
git add deploy/hermes/skills/oxenfurt_assignments.md README.md
git commit -m "docs(assignments): add Hermes assignment skill and README coverage"
```

---

## Self-Review Notes

Checked against `docs/superpowers/specs/2026-08-04-assignments-design.md`:

- Data model → Task 1. Archived-card rule → Tasks 1 and 3 (`loadActiveAssignment`, `markCardCompleted`).
- Lifecycle, lazy expiry, single-active → Tasks 3 and 4.
- All four API surfaces → Tasks 4, 5, 6. `drill` extension → Task 7.
- FSRS integrity rule (first answer per day measures, rest drill) → Tasks 7 and 8.
- UI variant C, empty state, free mode untouched → Task 9. Assignment session → Task 10. History → Task 11.
- Hermes skill and its six documented rules → Task 12.
- Every "consciously not doing" item from the spec is absent from every task, as intended.

Known follow-ups deliberately left out of scope: no `Summary` screen copy specific to assignments (the existing summary is accurate enough), and no backfill of `assignment_items` for cards ingested before this feature (there is nothing to backfill).
