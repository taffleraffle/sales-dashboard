-- 093_low_quality_flag.sql
--
-- Surfaces the brutal truth about the 2026-05-20 Drive-import batch:
-- 85 of 89 rows in the previews/ bucket have files that are either
-- truncated placeholders (1-3 MB pretending to be 60-100 MB) or
-- sub-par bitrate (0.2-0.4 Mbps, ~WhatsApp-call quality). They cannot
-- be downloaded or played at usable quality because the original
-- ingest pipeline stored only partial bytes.
--
-- The size_mb column lies — was populated from Drive metadata BEFORE
-- the file finished downloading, so DB says 72.6 MB but disk says
-- 1.7 MB. audit-preview-file-sizes.mjs probes the actual HEAD
-- content-length for each row and (script will) writes back is_low_quality
-- = TRUE so the UI can warn / filter these out.
--
-- is_low_quality = TRUE                  → row's stored file is unusable
-- low_quality_reason                     → short label: 'placeholder' (<3 MB), 'subpar' (<4 Mbps)
-- low_quality_detected_at                → when the audit script flagged it
--
-- Auto-clear: when a new TUS upload lands on the row (preview_url changes
-- to /incoming/), the flag should be unset — but for now the operator
-- triggers the audit script after a re-upload run.

BEGIN;

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS is_low_quality           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS low_quality_reason       TEXT,
  ADD COLUMN IF NOT EXISTS low_quality_actual_mb    NUMERIC,
  ADD COLUMN IF NOT EXISTS low_quality_detected_at  TIMESTAMPTZ;

-- Indexed partial — most rows have FALSE, we only need fast lookup of
-- the flagged minority for filter chips.
CREATE INDEX IF NOT EXISTS idx_lib_creative_library_is_low_quality
  ON public.lib_creative_library(is_low_quality) WHERE is_low_quality = TRUE;

NOTIFY pgrst, 'reload schema';

COMMIT;
