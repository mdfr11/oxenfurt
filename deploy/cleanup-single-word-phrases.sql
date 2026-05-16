-- One-off cleanup: phrases that turned out to be single words.
-- Before the multi-word check was added to PhrasePayloadSchema, Hermes
-- happily classified single words as `type='phrase'`. Convert them in
-- place to `type='vocab'`, remapping payload fields and computing term
-- offsets inside context_sentence.
--
-- Run this once on the VPS:
--   psql $DATABASE_URL -f deploy/cleanup-single-word-phrases.sql
--
-- The script is idempotent — re-running it after fixing the data is a
-- no-op. It also skips rows whose conversion would conflict with the
-- vocab uniqueness index (case-insensitive term), leaving them as
-- broken `phrase` rows so you can decide what to do (delete or rename).

BEGIN;

-- Preview what's about to be converted; safe to inspect before COMMIT.
SELECT
  id,
  payload->>'phrase' AS phrase_text,
  payload->>'translation' AS translation,
  LOWER(payload->>'phrase') AS would_become_term_lower
FROM cards
WHERE type = 'phrase'
  AND payload->>'phrase' !~ '\s';

-- Convert: phrase → vocab. Term offsets computed from POSITION() of the
-- single word inside context_sentence (case-insensitive via lower()).
-- If the term isn't found in the sentence, fall back to (0, length(term)).
UPDATE cards
SET
  type = 'vocab',
  payload = jsonb_build_object(
    'term', payload->>'phrase',
    'translation', payload->>'translation',
    'context_sentence', payload->>'context_sentence',
    'context_term_start',
      GREATEST(
        0,
        COALESCE(
          NULLIF(POSITION(LOWER(payload->>'phrase') IN LOWER(payload->>'context_sentence')), 0),
          1
        ) - 1
      ),
    'context_term_end',
      GREATEST(
        LENGTH(payload->>'phrase'),
        COALESCE(
          NULLIF(POSITION(LOWER(payload->>'phrase') IN LOWER(payload->>'context_sentence')), 0),
          1
        ) - 1 + LENGTH(payload->>'phrase')
      )
  )
WHERE type = 'phrase'
  AND payload->>'phrase' !~ '\s'
  -- Skip rows whose lowered phrase already exists as a vocab term —
  -- inserting would violate uniq_cards_vocab_term.
  AND NOT EXISTS (
    SELECT 1
    FROM cards AS existing
    WHERE existing.type = 'vocab'
      AND LOWER(existing.payload->>'term') = LOWER(cards.payload->>'phrase')
      AND existing.id <> cards.id
  );

-- Show what's left as orphaned single-word phrases (collisions with
-- existing vocab). You'll need to delete or rename these manually.
SELECT id, payload->>'phrase' AS still_orphaned
FROM cards
WHERE type = 'phrase'
  AND payload->>'phrase' !~ '\s';

COMMIT;
