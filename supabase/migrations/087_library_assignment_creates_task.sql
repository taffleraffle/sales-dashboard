-- 087_library_assignment_creates_task.sql
--
-- Concurrency between Creative Library and Editing Queue.
--
-- Problem: when Ben assigns a raw clip to an editor in the Library
-- (via detail modal or bulk edit), only lib_creative_library.assigned_editor_id
-- gets set. lib_editing_tasks is NOT touched, so the assignment never
-- appears in the editor's Timeline / List / Lanes view. Editors don't
-- know they have work to do.
--
-- Fix: trigger on lib_creative_library that mirrors the assignment into
-- lib_editing_tasks. Rules:
--   - On INSERT or UPDATE: if assigned_editor_id IS NOT NULL AND
--     status != 'edited', ensure a task row exists. If the creative
--     has no task yet, INSERT one (status='queued'). If it has one,
--     UPDATE its editor_id to match.
--   - When assigned_editor_id changes to NULL: clear editor_id on
--     existing open tasks (don't delete them — operator may want to
--     reassign later, and we'd lose state otherwise).
--   - When status flips to 'edited': mark any open tasks as 'done'
--     (auto-finalise).
--
-- Then BACKFILL existing orphans: for every library row with
-- assigned_editor_id IS NOT NULL AND status = 'raw' AND no task,
-- insert a task. As of 2026-05-20 there are ~11 of these.

BEGIN;

CREATE OR REPLACE FUNCTION public.lib_creative_assignment_sync()
RETURNS TRIGGER AS $$
DECLARE
  existing_task_id UUID;
BEGIN
  -- Only act on relevant column changes (or on every insert)
  IF TG_OP = 'UPDATE'
     AND NEW.assigned_editor_id IS NOT DISTINCT FROM OLD.assigned_editor_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Status flipped to edited → finalise any open tasks
  IF NEW.status = 'edited' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    UPDATE public.lib_editing_tasks
    SET status = 'done', completed_at = COALESCE(completed_at, now())
    WHERE creative_id = NEW.id
      AND status NOT IN ('done', 'blocked');
  END IF;

  -- Assigned editor changed
  IF TG_OP = 'INSERT' OR NEW.assigned_editor_id IS DISTINCT FROM OLD.assigned_editor_id THEN
    IF NEW.assigned_editor_id IS NULL THEN
      -- Unassign: clear editor_id on existing open tasks for this creative
      UPDATE public.lib_editing_tasks
      SET editor_id = NULL
      WHERE creative_id = NEW.id
        AND status NOT IN ('done', 'blocked');
    ELSIF NEW.status != 'edited' THEN
      -- Assignment to an editor on a not-yet-edited creative.
      -- Reuse existing open task if present, else insert a new one.
      SELECT id INTO existing_task_id
      FROM public.lib_editing_tasks
      WHERE creative_id = NEW.id
        AND status NOT IN ('done', 'blocked')
      ORDER BY created_at DESC
      LIMIT 1;

      IF existing_task_id IS NOT NULL THEN
        UPDATE public.lib_editing_tasks
        SET editor_id = NEW.assigned_editor_id,
            assigned_at = COALESCE(assigned_at, CURRENT_DATE)
        WHERE id = existing_task_id;
      ELSE
        INSERT INTO public.lib_editing_tasks (creative_id, editor_id, status, priority, task_type, assigned_at)
        VALUES (NEW.id, NEW.assigned_editor_id, 'queued', 'P2 - Medium', 'edit', CURRENT_DATE);
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lib_creative_assignment_sync ON public.lib_creative_library;
CREATE TRIGGER trg_lib_creative_assignment_sync
  AFTER INSERT OR UPDATE ON public.lib_creative_library
  FOR EACH ROW EXECUTE FUNCTION public.lib_creative_assignment_sync();

-- Backfill: existing orphans (assigned in Library, missing from Queue)
INSERT INTO public.lib_editing_tasks (creative_id, editor_id, status, priority, task_type, assigned_at)
SELECT c.id, c.assigned_editor_id, 'queued', 'P2 - Medium', 'edit', CURRENT_DATE
FROM public.lib_creative_library c
WHERE c.assigned_editor_id IS NOT NULL
  AND c.status = 'raw'
  AND NOT EXISTS (
    SELECT 1 FROM public.lib_editing_tasks t WHERE t.creative_id = c.id
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
