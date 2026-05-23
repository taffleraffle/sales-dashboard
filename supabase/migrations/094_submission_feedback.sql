-- 094_submission_feedback.sql
--
-- Ben (2026-05-23): "There's also no way for me to give feedback to any
-- of these. If they submit v1, I can't go and give feedback. I wanted to
-- email them or notify them that, 'Hey, you've received feedback on
-- this'..."
--
-- Adds per-submission feedback that admins leave on a v_n. Editors see
-- it in the /editor-view portal as a yellow banner + a FEEDBACK badge
-- on the task card. When the editor opens a task with feedback, we mark
-- it read so the badge clears.
--
-- Email/Slack delivery is deliberately NOT shipped here per Ben's call
-- (2026-05-23) - in-app banner is the v1 surface, email can be wired
-- via Resend later if needed.
--
-- Columns:
--   feedback_text       - admin's freeform feedback on this version
--   feedback_at         - when admin saved feedback (most recent edit)
--   feedback_by_name    - which admin left it (for audit + display)
--   feedback_read_at    - when the editor opened the task containing
--                         this submission with feedback. Used to clear
--                         the "you have feedback" banner on their side.
--
-- All four nullable - existing rows + new submissions start with no
-- feedback, populated when an admin clicks "Save feedback" in the
-- SubmissionsPanel.

BEGIN;

ALTER TABLE public.lib_task_submissions
  ADD COLUMN IF NOT EXISTS feedback_text     TEXT,
  ADD COLUMN IF NOT EXISTS feedback_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS feedback_by_name  TEXT,
  ADD COLUMN IF NOT EXISTS feedback_read_at  TIMESTAMPTZ;

-- Partial index for the editor portal's "unread feedback" query — only
-- the small set of feedback-having + not-yet-read submissions matters.
CREATE INDEX IF NOT EXISTS idx_lib_task_submissions_unread_feedback
  ON public.lib_task_submissions(task_id)
  WHERE feedback_text IS NOT NULL AND feedback_read_at IS NULL AND deleted_at IS NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
