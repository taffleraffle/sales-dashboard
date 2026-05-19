-- 079_creative_library_stage_urls.sql
--
-- Per-stage file URLs on lib_creative_library so one row tracks
-- a single creative through its production lifecycle:
--   drive_url        — Raw source (already exists)
--   rough_cut_url    — rough cut file
--   final_cut_url    — final cut file
--   approved_url     — approved master
--   delivered_url    — delivered version (e.g. uploaded to Meta)
--
-- Stage status (stage_rough_cut etc., from migration 078) remains the
-- state machine; these URLs are what each stage POINTS at when 'done'.

BEGIN;

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS rough_cut_url TEXT,
  ADD COLUMN IF NOT EXISTS final_cut_url TEXT,
  ADD COLUMN IF NOT EXISTS approved_url  TEXT,
  ADD COLUMN IF NOT EXISTS delivered_url TEXT;

NOTIFY pgrst, 'reload schema';

COMMIT;
