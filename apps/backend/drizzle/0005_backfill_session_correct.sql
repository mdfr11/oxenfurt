-- Recompute sessions.cards_correct for finished sessions using the new
-- "rating >= 3" definition (only Good and Easy count). Old sessions were
-- finalised by clients that treated Hard as correct too, so they all
-- showed 100% on the Stats screen even when the user rated everything
-- Hard — see commit 4d4c8f2.
--
-- The join window is started_at..finished_at. Single-user app means at
-- most one session is in flight at a time, so reviews can be attributed
-- to the session whose time window contains them. cards_reviewed is left
-- alone (it counts cards the user rated, regardless of correctness).

UPDATE sessions
SET cards_correct = sub.correct_count
FROM (
  SELECT
    s.id AS session_id,
    COUNT(r.id) FILTER (WHERE r.rating >= 3)::int AS correct_count
  FROM sessions s
  LEFT JOIN card_reviews r
    ON r.reviewed_at >= s.started_at
    AND r.reviewed_at <= s.finished_at
  WHERE s.finished_at IS NOT NULL
  GROUP BY s.id
) sub
WHERE sessions.id = sub.session_id;
