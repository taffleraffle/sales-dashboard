-- ============================================================
-- 121_launch_queue_position.sql
--
-- Manual priority ordering for the Launch queue tab. Default sort
-- is updated_at (newest/oldest toggle), but Ben wants to drag rows
-- into an explicit ship order — "do this first, then this, then this"
-- — and have that order persist across sessions and reloads.
--
-- Schema: a single NUMERIC column on lib_creative_library. NUMERIC
-- (not INTEGER) so the UI can drop a row between two existing
-- positions by computing the midpoint (e.g. between 1000 and 2000 →
-- 1500; between 1500 and 2000 → 1750; etc.) without ever needing
-- to renumber the whole list.
--
-- Sort rule (handled in the React layer):
--   1. Rows WITH a position sort FIRST, ascending by position
--      (smaller number = ship sooner).
--   2. Rows WITHOUT a position follow, sorted by the user's
--      newest/oldest toggle.
--
-- Effect: positioned rows form a "priority pile" at the top of the
-- queue. Marking a positioned row as launched removes it from the
-- queue entirely; positions don't need to be reshuffled because
-- the ordering is fully numeric.
-- ============================================================

BEGIN;

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS launch_queue_position NUMERIC;

-- Partial index on the actually-prioritized rows. The launch queue
-- filters on (status='edited' AND has_been_run=false), so we only
-- need the index covering that slice. Keeps the index tiny.
CREATE INDEX IF NOT EXISTS idx_lib_creative_launch_position
  ON public.lib_creative_library(launch_queue_position)
  WHERE launch_queue_position IS NOT NULL
    AND has_been_run = FALSE
    AND status = 'edited';

NOTIFY pgrst, 'reload schema';

COMMIT;
