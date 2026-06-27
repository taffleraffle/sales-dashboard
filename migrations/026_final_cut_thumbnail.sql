-- 026_final_cut_thumbnail.sql
-- Edited-frame thumbnail for the library grid tiles.
--
-- Problem: the matrix/tile thumbnail uses lib_creative_library.thumbnail_url,
-- which is the RAW frame. Once a clip has an edited cut, the tile should show
-- the EDITED frame, but that thumbnail lives on the submission row
-- (lib_task_submissions.thumbnail_url), not the creative.
--
-- Fix: store the edit's poster on the creative as final_cut_thumbnail_url,
-- populated whenever final_cut_url is set (upload + approve). The tile prefers
-- final_cut_thumbnail_url; the merged detail view keeps using thumbnail_url for
-- the RAW sidecar so both stay correct.

ALTER TABLE lib_creative_library
  ADD COLUMN IF NOT EXISTS final_cut_thumbnail_url TEXT;

COMMENT ON COLUMN lib_creative_library.final_cut_thumbnail_url IS
  'Poster frame of the edited cut (final_cut_url). Shown on library tiles so '
  'edited clips display the edit, not the raw. NULL = falls back to thumbnail_url.';

-- Backfill from the submission behind each clip's final_cut_url.
UPDATE lib_creative_library c
SET final_cut_thumbnail_url = s.thumbnail_url
FROM lib_task_submissions s
WHERE s.file_url = c.final_cut_url
  AND c.final_cut_url IS NOT NULL
  AND s.thumbnail_url IS NOT NULL
  AND s.deleted_at IS NULL
  AND c.final_cut_thumbnail_url IS NULL;

NOTIFY pgrst, 'reload schema';
