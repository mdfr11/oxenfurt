-- The original CHECK constraint on `cards.type` only allowed ('vocab',
-- 'theory'). Migration 0001 added a dedup index for `phrase` cards but
-- forgot to widen the CHECK — so every phrase INSERT would have raised
-- check_violation. (In practice the production DB has been edited
-- manually; this migration aligns the schema with the code path used
-- by ingest and lets CI's fresh DB accept phrase cards too.)

ALTER TABLE "cards" DROP CONSTRAINT IF EXISTS "cards_type_check";
ALTER TABLE "cards" ADD CONSTRAINT "cards_type_check"
  CHECK ("type" IN ('vocab', 'theory', 'phrase'));
