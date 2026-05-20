-- 089_manually_marked_used.sql
--
-- The Library filter has three STATUS buckets:
--   RAW          (needs editing — not used in any composite yet)
--   EDITED RAW   (raw clip already used in a finished composite)
--   EDITED       (finished cut — status='edited' in lib_creative_library)
--
-- The first two are both stored as status='raw'. The "already used"
-- distinction was, until now, DERIVED entirely from transcript-overlap
-- heuristics + the "raw Hook = always used" rule. That worked for the
-- read path (filtering, row decorations) but meant the operator
-- couldn't manually mark a raw clip as used from the Bulk Edit modal
-- when the heuristic missed it.
--
-- This migration adds a manual-override flag. When true, the row is
-- treated as "already used" regardless of what transcript matching
-- says. Default false, so existing behaviour is unchanged.

BEGIN;

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS manually_marked_used BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_lib_creative_library_manually_marked_used
  ON public.lib_creative_library(manually_marked_used)
  WHERE manually_marked_used = TRUE;

NOTIFY pgrst, 'reload schema';

COMMIT;
