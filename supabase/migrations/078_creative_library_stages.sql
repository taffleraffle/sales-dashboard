-- 078_creative_library_stages.sql
--
-- Per-stage status columns mirroring the Component Edits spreadsheet
-- layout — Raw → Rough Cut → Final Cut → Approved → Delivered.
-- Each stage value is NULL (not started), 'done', 'in_progress',
-- 'blocked', or 'skip'.
--
-- Plus production-tracking helpers:
--   priority           — P1 - High / P2 - Medium / P3 - Low
--   description        — short human description (separate from name)
--   assigned_editor_id — primary editor for this clip (different from
--                        per-task assignment in lib_editing_tasks)
--   parent_id          — when uploading an 'edited version' of an
--                        existing clip, point at the source row

BEGIN;

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS stage_rough_cut    TEXT,
  ADD COLUMN IF NOT EXISTS stage_final_cut    TEXT,
  ADD COLUMN IF NOT EXISTS stage_approved     TEXT,
  ADD COLUMN IF NOT EXISTS stage_delivered    TEXT,
  ADD COLUMN IF NOT EXISTS priority           TEXT,
  ADD COLUMN IF NOT EXISTS description        TEXT,
  ADD COLUMN IF NOT EXISTS assigned_editor_id UUID REFERENCES public.lib_creative_editors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_id          UUID REFERENCES public.lib_creative_library(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lib_creative_library_assigned_editor ON public.lib_creative_library(assigned_editor_id);
CREATE INDEX IF NOT EXISTS idx_lib_creative_library_parent          ON public.lib_creative_library(parent_id);
CREATE INDEX IF NOT EXISTS idx_lib_creative_library_priority        ON public.lib_creative_library(priority);

-- Storage bucket for edited versions uploaded via the EditTaskModal.
-- Public read, 1GB cap per file (editors might drop big files).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('creative-uploads', 'creative-uploads', TRUE, 1073741824,
        ARRAY['video/mp4','video/quicktime','video/webm','video/x-m4v'])
ON CONFLICT (id) DO UPDATE SET public = TRUE;

NOTIFY pgrst, 'reload schema';

COMMIT;
