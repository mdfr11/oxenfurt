-- Scopes: one "academy" per agent. One app, one Mini App, N decks.
--
-- Everything that used to implicitly belong to "the" deck gets a
-- scope_id: cards, assignments, sessions. card_reviews and
-- card_questions stay scope-less — they reach a scope through their
-- card FK, which keeps the boundary single-sourced.
--
-- Existing deployments get a single 'english' scope and every row
-- backfilled into it, so the migration is invisible to a running
-- single-scope operator.

CREATE TABLE "scopes" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"       text NOT NULL UNIQUE,
  "title"      text NOT NULL,
  "emoji"      text,
  "accent"     text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

INSERT INTO "scopes" ("slug", "title", "emoji", "accent")
VALUES ('english', 'English', '🇬🇧', 'indigo');
--> statement-breakpoint

ALTER TABLE "cards" ADD COLUMN "scope_id" uuid REFERENCES "scopes"("id");
--> statement-breakpoint
UPDATE "cards" SET "scope_id" = (SELECT "id" FROM "scopes" WHERE "slug" = 'english');
--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "scope_id" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "assignments" ADD COLUMN "scope_id" uuid REFERENCES "scopes"("id");
--> statement-breakpoint
UPDATE "assignments" SET "scope_id" = (SELECT "id" FROM "scopes" WHERE "slug" = 'english');
--> statement-breakpoint
ALTER TABLE "assignments" ALTER COLUMN "scope_id" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "sessions" ADD COLUMN "scope_id" uuid REFERENCES "scopes"("id");
--> statement-breakpoint
UPDATE "sessions" SET "scope_id" = (SELECT "id" FROM "scopes" WHERE "slug" = 'english');
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "scope_id" SET NOT NULL;
--> statement-breakpoint

-- Due-queue reads are the hottest path in the app and are always
-- scope-filtered; the old global (due) WHERE status='active' index is
-- superseded by (scope_id, due).
DROP INDEX "idx_cards_due_active";
--> statement-breakpoint
CREATE INDEX "idx_cards_due_active"
  ON "cards" ("scope_id", "due")
  WHERE "status" = 'active';
--> statement-breakpoint
DROP INDEX "idx_assignments_created";
--> statement-breakpoint
CREATE INDEX "idx_assignments_created"
  ON "assignments" ("scope_id", "created_at" DESC);
--> statement-breakpoint

-- One active assignment PER SCOPE, not globally: the english tutor and
-- the medicine tutor each own their slot and must not evict each other.
DROP INDEX "idx_assignments_single_active";
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_assignments_single_active"
  ON "assignments" ("scope_id")
  WHERE "status" = 'active';
--> statement-breakpoint

-- Dedup becomes per-scope: the same term is legitimately a different
-- card in two academies ("culture" in English vs. "culture" in a
-- biology scope), so term/phrase uniqueness now lives inside a scope.
DROP INDEX "uniq_cards_vocab_term";
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_cards_vocab_term"
  ON "cards" ("scope_id", (LOWER(payload->>'term')))
  WHERE "type" = 'vocab';
--> statement-breakpoint
DROP INDEX "uniq_cards_phrase_text";
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_cards_phrase_text"
  ON "cards" ("scope_id", (LOWER(payload->>'phrase')))
  WHERE "type" = 'phrase';
