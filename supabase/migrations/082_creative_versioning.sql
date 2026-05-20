-- 082_creative_versioning.sql
--
-- Per-creative versioning. Adds:
--   - version_number INT (default 1) — explicit version label so the UI
--     can show 'v1 / v2 / v3' chips and sort.
--   - index on parent_id — used to query 'all versions of this root'
--     in the detail modal sidebar.
--
-- Versioning model:
--   - v1 row: parent_id IS NULL, version_number = 1
--   - v2 row: parent_id = v1.id, version_number = 2
--   - v3 row: parent_id = v1.id, version_number = 3
--   ...
-- All sibling versions share the same parent_id (always pointing at v1).
-- That makes 'find all versions of X' a single index lookup.

BEGIN;

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS version_number INT NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_lib_creative_library_parent_id
  ON public.lib_creative_library(parent_id);

NOTIFY pgrst, 'reload schema';

COMMIT;
