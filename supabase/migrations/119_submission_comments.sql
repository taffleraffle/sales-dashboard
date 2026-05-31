-- ============================================================
-- 119_submission_comments.sql
--
-- Frame.io-style timestamped review comments on editor
-- submissions. Each row pins a comment to a specific video
-- timestamp (or NULL = general/non-timestamped). Threading via
-- parent_id; soft delete via deleted_at; explicit resolve flow
-- via resolved_at.
--
-- The dashboard's SubmissionPreviewModal renders these as
--   - pill markers on the video scrubber at their timestamp
--   - a sidebar list grouped by thread
-- Editors get a notification when a new comment lands on a
-- submission they own (lib_editor_notifications kind=
-- 'submission_comment').
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.lib_submission_comments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES public.lib_task_submissions(id) ON DELETE CASCADE,
  -- Threading. Top-level comment: parent_id NULL. Reply: parent_id
  -- points at the parent top-level comment (single-level threads —
  -- no nested replies-to-replies, keeps the UI sane).
  parent_id     UUID REFERENCES public.lib_submission_comments(id) ON DELETE CASCADE,
  -- The video timestamp this comment pins to, in seconds. NULL =
  -- general/non-timestamped comment. Replies inherit from their
  -- parent and store NULL here.
  timestamp_seconds NUMERIC(10,3),
  -- Who wrote it. author_id is the editors / auth user id (we
  -- don't FK-constrain because comments can come from either
  -- lib_creative_editors (an editor) or auth.users (an admin).
  author_id     UUID,
  author_kind   TEXT NOT NULL CHECK (author_kind IN ('admin', 'editor')),
  author_name   TEXT NOT NULL,
  body          TEXT NOT NULL,
  -- Resolution. Admins resolve when the issue is addressed in a
  -- later version; the resolved comment stays attached to the
  -- original submission for history but renders with a struck-
  -- through / muted style. NULL = open.
  resolved_at   TIMESTAMPTZ,
  resolved_by_name TEXT,
  -- Soft delete — same pattern as lib_task_submissions.
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lib_submission_comments_submission
  ON public.lib_submission_comments(submission_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lib_submission_comments_parent
  ON public.lib_submission_comments(parent_id)
  WHERE deleted_at IS NULL AND parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lib_submission_comments_timestamp
  ON public.lib_submission_comments(submission_id, timestamp_seconds)
  WHERE deleted_at IS NULL;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_submission_comments_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lib_submission_comments_updated_at
  ON public.lib_submission_comments;
CREATE TRIGGER trg_lib_submission_comments_updated_at
  BEFORE UPDATE ON public.lib_submission_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_submission_comments_updated_at();

-- Auto-notify the editor when an admin leaves a comment. Mirrors the
-- existing notifyEditor() pattern in AdsCreativeLibrary.jsx — but
-- driven by trigger here so editors get notified even if a comment
-- arrives through some non-dashboard surface (e.g. an admin posting
-- via curl / a future Slack integration).
CREATE OR REPLACE FUNCTION public.notify_editor_on_comment()
RETURNS TRIGGER AS $$
DECLARE
  v_task_id  UUID;
  v_editor_id UUID;
  v_creative_id UUID;
  v_version  INT;
BEGIN
  -- Only fire for admin-authored top-level comments + replies.
  -- An editor commenting on their own submission shouldn't
  -- self-notify.
  IF NEW.author_kind <> 'admin' THEN
    RETURN NEW;
  END IF;
  -- Resolve the submission's task → editor. Skip soft-deleted submissions
  -- so a comment on a tombstoned version doesn't spuriously ping the
  -- editor (their UI doesn't show the submission anyway).
  SELECT s.task_id, s.version_number
    INTO v_task_id, v_version
    FROM public.lib_task_submissions s
   WHERE s.id = NEW.submission_id
     AND s.deleted_at IS NULL;
  IF v_task_id IS NULL THEN
    RETURN NEW;  -- orphan / soft-deleted submission, no-op
  END IF;
  SELECT editor_id, creative_id
    INTO v_editor_id, v_creative_id
    FROM public.lib_editing_tasks
   WHERE id = v_task_id;
  IF v_editor_id IS NULL THEN
    RETURN NEW;  -- unassigned task
  END IF;
  INSERT INTO public.lib_editor_notifications
    (editor_id, kind, task_id, creative_id, submission_id, title, body, link_path)
  VALUES
    (v_editor_id,
     'submission_comment',
     v_task_id,
     v_creative_id,
     NEW.submission_id,
     'New comment on v' || COALESCE(v_version, 1),
     LEFT(NEW.body, 200),
     '/editor-view?task=' || v_task_id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_editor_on_comment
  ON public.lib_submission_comments;
CREATE TRIGGER trg_notify_editor_on_comment
  AFTER INSERT ON public.lib_submission_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_editor_on_comment();

-- RLS: allow-all to match the rest of the lib_* tables. Application-
-- layer scoping (editor-only-sees-their-own-tasks) is handled in the
-- React layer via the existing scope.editorId filter on parent reads.
ALTER TABLE public.lib_submission_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lib_submission_comments: read"  ON public.lib_submission_comments;
DROP POLICY IF EXISTS "lib_submission_comments: write" ON public.lib_submission_comments;
CREATE POLICY "lib_submission_comments: read"  ON public.lib_submission_comments FOR SELECT USING (TRUE);
CREATE POLICY "lib_submission_comments: write" ON public.lib_submission_comments FOR ALL    USING (TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lib_submission_comments TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
