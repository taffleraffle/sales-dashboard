-- 155_editing_queue_nickname_format.sql
-- Surface the creative nickname + format (added in migration 154) on the
-- editing-queue VIEW so the EDIT TASK modal can show the nickname as its
-- title and let the editor rename / tag format from there too.
--
-- Pure view republish — mirrors migration 104's definition exactly, with two
-- columns added (creative_custom_name, creative_style_format). No data change.
-- DROP+CREATE matches the pattern of 084/086/103/104.

DROP VIEW IF EXISTS public.lib_editing_queue;
CREATE VIEW public.lib_editing_queue AS
SELECT
  -- Task columns
  t.id                       AS task_id,
  t.status,
  t.priority,
  t.task_type,
  t.assigned_at,
  t.started_at,
  t.due_date,
  t.completed_at,
  t.notes,
  t.sort_order,
  -- Editor columns
  e.id                       AS editor_id,
  e.name                     AS editor_name,
  e.slug                     AS editor_slug,
  e.color                    AS editor_color,
  -- Creative columns (pre-103)
  c.id                       AS creative_id,
  c.name                     AS creative_name,
  c.canonical_name           AS creative_canonical_name,
  c.type                     AS creative_type,
  c.creator                  AS creative_creator,
  c.thumbnail_url,
  c.preview_url,
  c.drive_url,
  c.final_cut_url            AS final_cut_url,
  c.v21_script_id,
  c.status                   AS creative_status,
  -- Naming overhaul (103)
  c.display_name             AS creative_display_name,
  c.legacy_canonical         AS creative_legacy_canonical,
  c.messaging_angle          AS creative_messaging_angle,
  c.messaging_angle_override AS creative_messaging_angle_override,
  c.second_creator           AS creative_second_creator,
  c.offer_slug               AS creative_offer_slug,
  c.take_number              AS creative_take_number,
  c.project_tag              AS creative_project_tag,
  -- Triage (104)
  c.original_filename        AS creative_original_filename,
  c.bad_take_source          AS creative_bad_take_source,
  c.triaged_at               AS creative_triaged_at,
  c.upload_batch_id          AS creative_upload_batch_id,
  -- Nickname + format (154/155)
  c.custom_name              AS creative_custom_name,
  c.style_format             AS creative_style_format,
  -- is_overdue per Ben's 2026-05-31 rule (status='review' suppresses)
  (t.due_date IS NOT NULL
    AND t.due_date < CURRENT_DATE
    AND t.status NOT IN ('done', 'blocked', 'review')) AS is_overdue
FROM public.lib_editing_tasks t
LEFT JOIN public.lib_creative_editors  e ON e.id = t.editor_id
LEFT JOIN public.lib_creative_library  c ON c.id = t.creative_id;

GRANT SELECT ON public.lib_editing_queue TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
