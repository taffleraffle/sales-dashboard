-- 031_creative_outcome.sql
-- Manual winner/loser grade on a creative itself, set from the library detail
-- modal next to "Run before?" (Ben 2026-06-29: needs to mark a clip a winner or
-- not, not just whether it ran). Mirrors ads.outcome (migration 028) but lives
-- on the creative so the judgement travels with the clip.
ALTER TABLE lib_creative_library
  ADD COLUMN IF NOT EXISTS outcome TEXT CHECK (outcome IN ('winner', 'loser'));

COMMENT ON COLUMN lib_creative_library.outcome IS
  'Manual winner/loser grade for the creative, set from the library detail modal — winner | loser | NULL.';

NOTIFY pgrst, 'reload schema';
