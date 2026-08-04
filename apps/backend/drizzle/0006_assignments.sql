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
