-- Perf indexes flagged by the DB review. None of these change semantics,
-- they just give the planner a usable plan on hot paths.

-- /cards/sources and /cards/related — group/filter by cards.source on
-- active rows. Sequential scan today; trivial at low row counts but
-- linear in card count. Partial index keeps it tiny because we only
-- ever query active rows from these endpoints.
CREATE INDEX IF NOT EXISTS "idx_cards_source_active"
  ON "cards" ("source")
  WHERE "status" = 'active';

-- /stats heatmap + streak + /sessions/stats time-window FILTER
-- aggregates all scan card_reviews by a `reviewed_at >= …` window.
-- The existing composite (card_id, reviewed_at) covers card-scoped
-- queries; a dedicated (reviewed_at) index unblocks the stats path.
CREATE INDEX IF NOT EXISTS "idx_reviews_reviewed_at"
  ON "card_reviews" ("reviewed_at");
