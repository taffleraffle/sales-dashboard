-- 084_editing_queue_canonical_name.sql
--
-- The Editing Queue's Timeline / Kanban / List views show task bars with
-- the raw filename (`creative_name = c.name`). That's noisy — Ben wants
-- to see the canonical name (e.g. `BODY-OSO-J.3`) on the bar with the
-- raw filename as secondary context. Add `c.canonical_name` to the
-- view's projection so all task views can read it without an extra join.
--
-- View-only change. No data migration. Idempotent (CREATE OR REPLACE).

BEGIN;

-- DROP + CREATE because CREATE OR REPLACE VIEW cannot add columns in the
-- middle of the projection (it can only append).
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
