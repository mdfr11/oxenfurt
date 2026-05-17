-- Migration 0001 created the phrase dedup index with regexp_replace to
-- collapse whitespace differences. The ingest code was later simplified
-- to use a plain LOWER(payload->>'phrase'), but the index was left as-is.
-- Postgres requires the ON CONFLICT inference expression to match the
-- index expression *exactly* (text-equality), so every phrase insert
-- started raising "no unique or exclusion constraint matching the ON
-- CONFLICT specification" — caught only in CI, where the integration
-- tests actually run against real Postgres.
--
-- Drop the old index, recreate with the simpler expression to match the
-- ingest path. Valibot already .trim()s phrases on the way in, so
-- leading/trailing whitespace differences don't reach the index either
-- way; the only thing we lose is collapsing of *internal* duplicated
-- whitespace, which is rare enough to not be worth the inference cost.

DROP INDEX IF EXISTS "uniq_cards_phrase_text";

CREATE UNIQUE INDEX "uniq_cards_phrase_text"
  ON "cards" ((LOWER(payload->>'phrase')))
  WHERE "type" = 'phrase';
