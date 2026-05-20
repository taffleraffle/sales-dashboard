-- 086_editing_task_sort_order.sql
--
-- Adds a manual sort_order INT to lib_editing_tasks so the operator can
-- drag rows in the queue's List view to reorder priority. The list sorts
-- by sort_order ASC first (when set), then by priority + due_date.
--
-- sort_order is nullable — only tasks the operator has explicitly
-- reordered carry a value. Default behaviour (priority + due_date sort)
-- still applies to anything without a manual rank.
--
-- The view lib_editing_queue is republished to surface t.sort_order so
-- the client can read + write it in one place.

BEGIN;

ALTER TABLE public.lib_editing_tasks
  ADD COLUMN IF NOT EXISTS sort_order INT;

CREATE INDEX IF NOT EXISTS idx_lib_editing_tasks_sort_order
  ON public.lib_editing_tasks(sort_order)
  WHERE sort_order IS NOT NULL;

-- Republish view to surface sort_order
DROP VIEW IF EXISTS public.lib_editing_queue;

CREATE VIEW public.lib_editing_queue AS
SELECT
  t.id              AS task_id,
  t.status,
  t.priority,
  t.task_type,
  t.assigned_at,
  t.started_at,
  t.due_date,
  t.completed_at,
  t.notes,
  t.sort_order,
  e.id              AS editor_id,
  e.name            AS editor_name,
  e.slug            AS editor_slug,
  e.color           AS editor_color,
  c.id              AS creative_id,
  c.name            AS creative_name,
  c.canonical_name  AS creative_canonical_name,
  c.type            AS creative_type,
  c.creator         AS creative_creator,
  c.thumbnail_url,
  c.preview_url,
  c.drive_url,
  c.v21_script_id,
  c.status          AS creative_status,
  (t.due_date IS NOT NULL
    AND t.due_date < CURRENT_DATE
    AND t.status NOT IN ('done', 'blocked')) AS is_overdue
FROM public.lib_editing_tasks t
LEFT JOIN public.lib_creative_editors  e ON e.id = t.editor_id
LEFT JOIN public.lib_creative_library  c ON c.id = t.creative_id;

GRANT SELECT ON public.lib_editing_queue TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
