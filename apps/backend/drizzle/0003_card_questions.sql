-- User-written notes / questions attached to specific cards. Created by
-- the Mini App, picked up asynchronously by the Hermes Agent which writes
-- back a response (and optionally ingests new related cards via the
-- existing /ingest/cards path). The user reads answers back through the
-- Mini App; nothing else touches this table.
--
-- Lifecycle: created status='pending' → Hermes flips to 'answered' on
-- /agent/questions/:id/response. User-side delete sets 'discarded' so
-- the read history is preserved across reopens.

CREATE TABLE "card_questions" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "card_id"      uuid NOT NULL REFERENCES "cards"("id") ON DELETE CASCADE,
  "question"     text NOT NULL,
  "status"       text NOT NULL DEFAULT 'pending',
  "response"     text,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "answered_at"  timestamptz,
  "seen_at"      timestamptz,
  CONSTRAINT "card_questions_status_check"
    CHECK ("status" IN ('pending', 'answered', 'discarded'))
);
--> statement-breakpoint

-- Hermes polls pending questions cheaply.
CREATE INDEX "idx_card_questions_pending"
  ON "card_questions" ("created_at")
  WHERE "status" = 'pending';
--> statement-breakpoint

-- "What did I ask on this card?" listing.
CREATE INDEX "idx_card_questions_card"
  ON "card_questions" ("card_id", "created_at" DESC);
--> statement-breakpoint

-- "Unread answers" badge on Home — answered AND not yet seen by the user.
CREATE INDEX "idx_card_questions_unread"
  ON "card_questions" ("answered_at" DESC)
  WHERE "status" = 'answered' AND "seen_at" IS NULL;
