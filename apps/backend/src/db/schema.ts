import { sql } from 'drizzle-orm'
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import type { CardStatus, CardType, PhrasePayload, TheoryPayload, VocabPayload } from '@oxenfurt/shared'

export const cards = pgTable(
  'cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').$type<CardType>().notNull(),
    status: text('status').$type<CardStatus>().notNull().default('active'),
    payload: jsonb('payload').$type<VocabPayload | TheoryPayload | PhrasePayload>().notNull(),
    source: text('source'),
    sourceQuote: text('source_quote'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    // FSRS state — flat for indexing.
    fsrsState: smallint('fsrs_state').notNull(),
    due: timestamp('due', { withTimezone: true, mode: 'date' }).notNull(),
    stability: real('stability').notNull(),
    difficulty: real('difficulty').notNull(),
    elapsedDays: real('elapsed_days').notNull(),
    scheduledDays: real('scheduled_days').notNull(),
    learningSteps: smallint('learning_steps').notNull().default(0),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    lastReview: timestamp('last_review', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('idx_cards_due_active')
      .on(t.due)
      .where(sql`status = 'active'`),
    index('idx_cards_status_type').on(t.status, t.type),
  ],
)

export type CardRow = typeof cards.$inferSelect

export const cardReviews = pgTable(
  'card_reviews',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    rating: smallint('rating').notNull(),
    fsrsStateBefore: smallint('fsrs_state_before').notNull(),
    fsrsStateAfter: smallint('fsrs_state_after').notNull(),
    stabilityAfter: real('stability_after').notNull(),
    difficultyAfter: real('difficulty_after').notNull(),
    elapsedDays: real('elapsed_days').notNull(),
    scheduledDays: real('scheduled_days').notNull(),
  },
  (t) => [index('idx_reviews_card').on(t.cardId, t.reviewedAt)],
)


export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
  cardsReviewed: integer('cards_reviewed').notNull().default(0),
  cardsCorrect: integer('cards_correct').notNull().default(0),
})

export type SessionRow = typeof sessions.$inferSelect

export type CardQuestionStatus = 'pending' | 'answered' | 'discarded'

export const cardQuestions = pgTable('card_questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id')
    .notNull()
    .references(() => cards.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  status: text('status').$type<CardQuestionStatus>().notNull().default('pending'),
  response: text('response'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  answeredAt: timestamp('answered_at', { withTimezone: true, mode: 'date' }),
  seenAt: timestamp('seen_at', { withTimezone: true, mode: 'date' }),
})

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

