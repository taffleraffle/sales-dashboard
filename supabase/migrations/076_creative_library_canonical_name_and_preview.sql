-- 076_creative_library_canonical_name_and_preview.sql
--
-- Two additions to lib_creative_library:
--   canonical_name TEXT — programmatically-derived consistent filename
--                          (<TYPE>-<CREATOR>-<LABEL>-T<NN>.<ext>)
--   preview_url    TEXT — self-hosted small-format preview MP4
--                          (Supabase Storage public URL) for in-app playback
--                          without Drive's processing-pipeline lag

BEGIN;

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS canonical_name TEXT,
  ADD COLUMN IF NOT EXISTS preview_url    TEXT;

CREATE INDEX IF NOT EXISTS idx_lib_creative_library_canonical_name
  ON public.lib_creative_library(canonical_name);

-- Create the previews bucket (public-read; 200 MB cap per file is plenty for
-- 720p H.264 previews of short ads).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('creative-previews', 'creative-previews', TRUE, 209715200,
        ARRAY['video/mp4','video/quicktime','video/webm'])
ON CONFLICT (id) DO UPDATE SET public = TRUE;

NOTIFY pgrst, 'reload schema';

COMMIT;
