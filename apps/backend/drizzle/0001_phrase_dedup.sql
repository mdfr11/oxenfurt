-- Phrase dedup: case-insensitive on the phrase inside JSONB payload.
-- Mirrors the vocab term index. Whitespace is collapsed to a single space
-- so "take  into account" and "take into account" don't both insert.
CREATE UNIQUE INDEX "uniq_cards_phrase_text"
  ON "cards" ((LOWER(regexp_replace(payload->>'phrase', '\s+', ' ', 'g'))))
  WHERE "type" = 'phrase';
