-- 027_creative_content_category.sql
-- Ad creatives vs Short creatives on the editing queue.
--
-- The queue handles paid AD creatives today. Ben wants the same queue to also
-- carry SHORT-form creatives (Reels / TikTok / YT Shorts), switched by a top
-- Ads | Shorts toggle. A short is a content FORMAT, so it's a category on the
-- creative. Identical workflow either way — the toggle just filters the board.

ALTER TABLE lib_creative_library
  ADD COLUMN IF NOT EXISTS content_category TEXT NOT NULL DEFAULT 'ad'
  CHECK (content_category IN ('ad', 'short'));

COMMENT ON COLUMN lib_creative_library.content_category IS
  'ad = paid ad creative; short = short-form vertical/organic content. Drives '
  'the Ads | Shorts toggle on the editing queue. Defaults ad (current pipeline).';

-- Expose it on the queue view. Reproduces the current definition verbatim and
-- only adds c.content_category, so nothing the UI reads is dropped.
CREATE OR REPLACE VIEW public.lib_editing_queue AS
SELECT t.id AS task_id,
    t.status,
    t.priority,
    t.task_type,
    t.assigned_at,
    t.started_at,
    t.due_date,
    t.completed_at,
    t.notes,
    t.sort_order,
    e.id AS editor_id,
    e.name AS editor_name,
    e.slug AS editor_slug,
    e.color AS editor_color,
    c.id AS creative_id,
    c.name AS creative_name,
    c.canonical_name AS creative_canonical_name,
    c.type AS creative_type,
    c.creator AS creative_creator,
    c.thumbnail_url,
    c.preview_url,
    c.drive_url,
    c.final_cut_url,
    c.v21_script_id,
    c.status AS creative_status,
    c.display_name AS creative_display_name,
    c.legacy_canonical AS creative_legacy_canonical,
    c.messaging_angle AS creative_messaging_angle,
    c.messaging_angle_override AS creative_messaging_angle_override,
    c.second_creator AS creative_second_creator,
    c.offer_slug AS creative_offer_slug,
    c.take_number AS creative_take_number,
    c.project_tag AS creative_project_tag,
    c.original_filename AS creative_original_filename,
    c.bad_take_source AS creative_bad_take_source,
    c.triaged_at AS creative_triaged_at,
    c.upload_batch_id AS creative_upload_batch_id,
    -- content_category appended LAST: CREATE OR REPLACE VIEW only allows new
    -- columns at the end (can't reorder existing ones).
    t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE AND (t.status <> ALL (ARRAY['done'::text, 'blocked'::text, 'review'::text])) AS is_overdue,
    c.content_category
   FROM lib_editing_tasks t
     LEFT JOIN lib_creative_editors e ON e.id = t.editor_id
     LEFT JOIN lib_creative_library c ON c.id = t.creative_id;

NOTIFY pgrst, 'reload schema';
