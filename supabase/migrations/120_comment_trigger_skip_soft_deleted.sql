-- ============================================================
-- 120_comment_trigger_skip_soft_deleted.sql
--
-- Hotfix for the notify_editor_on_comment trigger introduced in
-- migration 119. The original logic looked up the submission's
-- task without filtering deleted_at, so a comment landing on a
-- soft-deleted submission would still fire an editor notification.
-- Editors don't see deleted submissions in their UI, so the bell
-- entry pointed at a dead row.
--
-- This migration is safe to re-apply — CREATE OR REPLACE FUNCTION
-- swaps the body in place; the trigger binding stays the same.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.notify_editor_on_comment()
RETURNS TRIGGER AS $$
DECLARE
  v_task_id     UUID;
  v_editor_id   UUID;
  v_creative_id UUID;
  v_version     INT;
BEGIN
  IF NEW.author_kind <> 'admin' THEN
    RETURN NEW;
  END IF;
  -- Skip soft-deleted submissions (added 2026-06-01 per code review).
  SELECT s.task_id, s.version_number
    INTO v_task_id, v_version
    FROM public.lib_task_submissions s
   WHERE s.id = NEW.submission_id
     AND s.deleted_at IS NULL;
  IF v_task_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT editor_id, creative_id
    INTO v_editor_id, v_creative_id
    FROM public.lib_editing_tasks
   WHERE id = v_task_id;
  IF v_editor_id IS NULL THEN
    RETURN NEW;
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

NOTIFY pgrst, 'reload schema';

COMMIT;
