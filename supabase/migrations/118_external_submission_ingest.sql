-- ============================================================
-- 118_external_submission_ingest.sql
--
-- When an editor submits a Frame.io / Google Drive / Dropbox /
-- direct review link as an external_url on lib_task_submissions,
-- automatically pull the underlying video into Supabase storage
-- so admins can review it inside the dashboard (the existing
-- SubmissionPreviewModal can only play file_url-backed
-- submissions; external_url renders as an "Open in new tab" link
-- which forces the operator out of the dashboard).
--
-- Pipeline:
--   1. INSERT on lib_task_submissions with external_url set, no
--      file_url → BEFORE trigger stamps ingest_status='pending' +
--      detected ingest_source.
--   2. AFTER trigger calls pg_net to fire the
--      ingest-external-submission Edge Function with the new row id.
--   3. Edge function fetches the file, uploads to
--      creative-uploads/external-pulls/<submission_id>.<ext>,
--      patches the submission row to set file_url + clears
--      ingest_status to NULL on success, or sets ingest_status=
--      'failed' + ingest_error_text on failure (and emits a
--      lib_editor_notifications row for the editor).
--
-- The editor's original external_url is PRESERVED for traceability
-- — we don't overwrite it. The UI prioritises file_url for playback
-- but still surfaces the external link as a secondary action.
-- ============================================================

BEGIN;

-- 1. Ingestion-state columns on the submission row.
ALTER TABLE public.lib_task_submissions
  -- 'pending'  → trigger fired, edge function not yet completed
  -- 'success'  → file_url populated by edge function
  -- 'failed'   → edge function gave up (see ingest_error_text)
  -- NULL       → no external_url to ingest (TUS upload path), or
  --              ingestion succeeded long enough ago that the UI
  --              no longer needs a chip
  ADD COLUMN IF NOT EXISTS ingest_status        TEXT,
  ADD COLUMN IF NOT EXISTS ingest_source        TEXT,   -- 'drive'|'frameio'|'dropbox'|'direct'
  ADD COLUMN IF NOT EXISTS ingest_started_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ingest_completed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ingest_error_text    TEXT,
  ADD COLUMN IF NOT EXISTS ingest_attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_lib_task_submissions_ingest_status
  ON public.lib_task_submissions(ingest_status)
  WHERE ingest_status IN ('pending', 'failed');

-- 2. Detect ingest_source from a URL. Pure SQL so the BEFORE
-- trigger can stamp it without a round-trip. Order matters — we
-- look for the more-specific hosts first.
CREATE OR REPLACE FUNCTION public.detect_ingest_source(url TEXT)
RETURNS TEXT AS $$
BEGIN
  IF url IS NULL OR url = '' THEN
    RETURN NULL;
  END IF;
  IF url ~* '(drive\.google\.com|docs\.google\.com/file)' THEN
    RETURN 'drive';
  END IF;
  IF url ~* '(frame\.io|f\.io)' THEN
    RETURN 'frameio';
  END IF;
  IF url ~* '(dropbox\.com|dropboxusercontent\.com)' THEN
    RETURN 'dropbox';
  END IF;
  -- Fall back to 'direct' for anything else with an http(s) scheme.
  IF url ~* '^https?://' THEN
    RETURN 'direct';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 3. BEFORE INSERT trigger — stamp pending + source so the row is
-- queryable as "pending" even before pg_net's POST completes.
CREATE OR REPLACE FUNCTION public.stamp_ingest_pending()
RETURNS TRIGGER AS $$
BEGIN
  -- Only mark pending when we have an external_url + no file_url.
  -- TUS-uploaded submissions already have file_url set at insert
  -- time and don't need ingestion.
  IF NEW.external_url IS NOT NULL
     AND NEW.external_url <> ''
     AND (NEW.file_url IS NULL OR NEW.file_url = '') THEN
    NEW.ingest_status := 'pending';
    NEW.ingest_source := public.detect_ingest_source(NEW.external_url);
    NEW.ingest_started_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stamp_ingest_pending ON public.lib_task_submissions;
CREATE TRIGGER trg_stamp_ingest_pending
  BEFORE INSERT ON public.lib_task_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_ingest_pending();

-- 4. AFTER INSERT trigger — dispatch the Edge Function via pg_net.
-- pg_net is already enabled (migration 015 / 054). Fire-and-forget;
-- the edge function self-updates the row when it completes.
--
-- NOTE: requires `app.settings.supabase_url` GUC to be set with the
-- project ref. If not set, the trigger falls back to a hard-coded URL
-- pointing at the prod project; change this if you ever clone.
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.fire_ingest_external_submission()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ingest_status = 'pending' THEN
    PERFORM net.http_post(
      url := 'https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/ingest-external-submission',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object('submission_id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fire_ingest_external_submission
  ON public.lib_task_submissions;
CREATE TRIGGER trg_fire_ingest_external_submission
  AFTER INSERT ON public.lib_task_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.fire_ingest_external_submission();

-- 5. Manual-retry RPC. The Activity / Editing queue UI exposes a
-- "Retry" button on failed ingests; the button calls this RPC to
-- reset the row to pending + re-fire the edge function. Distinct
-- from the trigger path so we can bump the attempt count.
CREATE OR REPLACE FUNCTION public.retry_external_ingest(p_submission_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_url TEXT;
BEGIN
  UPDATE public.lib_task_submissions
  SET ingest_status        = 'pending',
      ingest_started_at    = now(),
      ingest_completed_at  = NULL,
      ingest_error_text    = NULL,
      ingest_attempt_count = COALESCE(ingest_attempt_count, 0) + 1
  WHERE id = p_submission_id
    AND external_url IS NOT NULL
    AND external_url <> ''
  RETURNING external_url INTO v_url;

  IF v_url IS NULL THEN
    RETURN FALSE;
  END IF;

  PERFORM net.http_post(
    url := 'https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/ingest-external-submission',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('submission_id', p_submission_id)
  );
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.retry_external_ingest(UUID) TO anon, authenticated;

-- 6. Make sure the existing creative-uploads bucket accepts
-- external-pulled files. The bucket already exists from migration
-- 078 (1GB limit, public, video MIME types). external-pulls/ is a
-- folder convention inside it — no separate bucket needed.

NOTIFY pgrst, 'reload schema';

COMMIT;
