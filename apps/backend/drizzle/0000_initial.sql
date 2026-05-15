-- Oxenfurt initial schema
-- cards: vocab + theory in one table, discriminated by `type`, payload in JSONB.
-- card_reviews: FSRS review log, one row per rating.
-- sessions: review session lifecycle for analytics.

CREATE TABLE "cards" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "type"            text NOT NULL,
  "status"          text NOT NULL DEFAULT 'active',
  "payload"         jsonb NOT NULL,
  "source"          text,
  "source_quote"    text,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "fsrs_state"      smallint NOT NULL,
  "due"             timestamptz NOT NULL,
  "stability"       real NOT NULL,
  "difficulty"      real NOT NULL,
  "elapsed_days"    real NOT NULL,
  "scheduled_days"  real NOT NULL,
  "learning_steps"  smallint NOT NULL DEFAULT 0,
  "reps"            integer NOT NULL DEFAULT 0,
  "lapses"          integer NOT NULL DEFAULT 0,
  "last_review"     timestamptz,
  CONSTRAINT "cards_type_check" CHECK ("type" IN ('vocab', 'theory')),
  CONSTRAINT "cards_status_check" CHECK ("status" IN ('draft', 'active', 'archived')),
  CONSTRAINT "cards_fsrs_state_check" CHECK ("fsrs_state" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE INDEX "idx_cards_due_active" ON "cards" ("due") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "idx_cards_status_type" ON "cards" ("status", "type");
--> statement-breakpoint
-- Vocab dedup: case-insensitive on the term inside JSONB payload.
CREATE UNIQUE INDEX "uniq_cards_vocab_term"
  ON "cards" ((LOWER(payload->>'term')))
  WHERE "type" = 'vocab';
--> statement-breakpoint

CREATE TABLE "card_reviews" (
  "id"                 bigserial PRIMARY KEY,
  "card_id"            uuid NOT NULL REFERENCES "cards"("id") ON DELETE CASCADE,
  "reviewed_at"        timestamptz NOT NULL DEFAULT now(),
  "rating"             smallint NOT NULL,
  "fsrs_state_before"  smallint NOT NULL,
  "fsrs_state_after"   smallint NOT NULL,
  "stability_after"    real NOT NULL,
  "difficulty_after"   real NOT NULL,
  "elapsed_days"       real NOT NULL,
  "scheduled_days"     real NOT NULL,
  CONSTRAINT "card_reviews_rating_check" CHECK ("rating" BETWEEN 1 AND 4)
);
--> statement-breakpoint
CREATE INDEX "idx_reviews_card" ON "card_reviews" ("card_id", "reviewed_at");
--> statement-breakpoint

CREATE TABLE "sessions" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "started_at"      timestamptz NOT NULL DEFAULT now(),
  "finished_at"     timestamptz,
  "cards_reviewed"  integer NOT NULL DEFAULT 0,
  "cards_correct"   integer NOT NULL DEFAULT 0
);
