-- 090_task_submissions.sql
--
-- Submission versioning for the editing queue. Previously every upload
-- from the EditTaskModal overwrote lib_creative_library.final_cut_url —
-- there was no way for Ben to see what an editor submitted as v1 if
-- they then uploaded v2. Editors also couldn't get a revision history,
-- and there was no way to delete a bad submission without losing the
-- whole record.
--
-- This migration creates lib_task_submissions: one row per upload,
-- ordered by created_at. The detail modal renders these as a stack of
-- cards (newest first), with per-submission Approve + Delete buttons.
-- Approving a submission propagates its URL back to the creative's
-- final_cut_url so existing read paths (library matrix, etc.) keep
-- pointing at the canonical "best" cut.
--
-- Soft delete via deleted_at — keeps the audit trail even if the file
-- is removed from storage.

BEGIN;

CREATE TABLE IF NOT EXISTS public.lib_task_submissions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id             UUID NOT NULL REFERENCES public.lib_editing_tasks(id) ON DELETE CASCADE,
  -- Who submitted it. submitted_by_editor_id only set when the upload
  -- came via an editor share link bound to that editor; null on team-
  -- wide links + admin uploads.
  submitted_by_editor_id  UUID REFERENCES public.lib_creative_editors(id) ON DELETE SET NULL,
  submitted_by_name       TEXT,
  -- Either a file_url (uploaded to creative-uploads bucket) OR an
  -- external_url (Frame.io / Drive / Dropbox review link) — at least
  -- one must be set.
  file_url            TEXT,
  file_storage_path   TEXT,
  external_url        TEXT,
  -- Generated thumbnail (only present when a file was uploaded).
  thumbnail_url       TEXT,
  -- Optional submission note from the editor.
  notes               TEXT,
  -- Version number — auto-assigned at insert time as
  -- (current count of non-deleted submissions for this task) + 1.
  version_number      INT NOT NULL DEFAULT 1,
  -- Approval state. approved_at NULL = pending review.
  approved_at         TIMESTAMPTZ,
  approved_by_name    TEXT,
  -- Soft delete so we keep the history even after file removal.
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_has_url CHECK (file_url IS NOT NULL OR external_url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_lib_task_submissions_task_id
  ON public.lib_task_submissions(task_id);
CREATE INDEX IF NOT EXISTS idx_lib_task_submissions_approved
  ON public.lib_task_submissions(task_id) WHERE approved_at IS NOT NULL AND deleted_at IS NULL;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_task_submissions_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lib_task_submissions_updated_at ON public.lib_task_submissions;
CREATE TRIGGER trg_lib_task_submissions_updated_at
  BEFORE UPDATE ON public.lib_task_submissions
  FOR EACH ROW EXECUTE FUNCTION public.touch_task_submissions_updated_at();

-- RLS: same allow-all pattern as the rest of the lib_* tables.
ALTER TABLE public.lib_task_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lib_task_submissions: read"  ON public.lib_task_submissions;
DROP POLICY IF EXISTS "lib_task_submissions: write" ON public.lib_task_submissions;
CREATE POLICY "lib_task_submissions: read"  ON public.lib_task_submissions FOR SELECT USING (TRUE);
CREATE POLICY "lib_task_submissions: write" ON public.lib_task_submissions FOR ALL    USING (TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lib_task_submissions TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
