-- Triage + bad-takes detection infrastructure.
--
-- New columns on lib_creative_library:
--   original_filename     — Sony camera filename preserved as-is for audit.
--                           `name` is now the renamed RAW-YYMMDD-ACTOR-Sxx-NNN form.
--   bad_take_source       — provenance of the is_bad_take=true flag:
--                           'upload'      (Layer 1: operator toggled at upload)
--                           'heuristic'   (Layer 2: filename pattern or <3s duration)
--                           'ai'          (Layer 3: transcript review by Claude)
--                           'coordinator' (post-upload manual flag by Kirill)
--   triaged_at            — when the coordinator approved or flagged this row in the
--                           Triage tab. NULL = still needs triage. Once set, the row
--                           drops out of the Triage queue and behaves like any library row.
--   triaged_by_editor_id  — who triaged it. FK to lib_creative_editors so we can audit.
--
-- New table lib_upload_batches:
--   One row per Upload-modal session. Used to compute the batch_seq token
--   in the rename scheme RAW-{YYMMDD}-{ACTOR}-S{batch_seq}-{file_seq}.
--   Per-actor-per-day counter — every actor's first batch on a given day is S01,
--   second is S02, etc. Resets nightly per the date_local field.
--
-- Function next_batch_seq:
--   Returns the next per-actor-per-day batch number. Used by the Upload modal
--   to allocate a fresh batch_seq before inserting library rows. Race-safe via
--   transactional UPDATE...RETURNING pattern (advisory lock keyed by actor+date).

BEGIN;

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS original_filename    TEXT,
  ADD COLUMN IF NOT EXISTS bad_take_source      TEXT,
  ADD COLUMN IF NOT EXISTS triaged_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS triaged_by_editor_id UUID REFERENCES public.lib_creative_editors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS upload_batch_id      UUID;

-- Index lookups for the triage tab (last 24h ∪ untriaged ∪ ai-flagged).
CREATE INDEX IF NOT EXISTS idx_lib_creative_library_triage
  ON public.lib_creative_library (triaged_at, added_at DESC);

-- Source lookup for audit ("how many AI false positives this week").
CREATE INDEX IF NOT EXISTS idx_lib_creative_library_bad_take_source
  ON public.lib_creative_library (bad_take_source)
  WHERE is_bad_take = TRUE;

-- One row per Upload-modal session.
CREATE TABLE IF NOT EXISTS public.lib_upload_batches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by_user_id UUID,                  -- auth.users.id, nullable
  uploaded_by_label   TEXT,                  -- "Ben" / "Kirill" — display only
  actor_creator       TEXT NOT NULL,         -- "TANYA" — batch-level default
  date_local          DATE NOT NULL,         -- YYYY-MM-DD in NZ tz for the per-day rollover
  batch_seq           INT NOT NULL,          -- per-actor-per-day counter (1, 2, 3, ...)
  file_count          INT DEFAULT 0,         -- denormalized for the batch label
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (actor_creator, date_local, batch_seq)
);

CREATE INDEX IF NOT EXISTS idx_lib_upload_batches_actor_date
  ON public.lib_upload_batches (actor_creator, date_local DESC);

-- Fast forward-FK lookup from creative -> batch.
CREATE INDEX IF NOT EXISTS idx_lib_creative_library_upload_batch
  ON public.lib_creative_library (upload_batch_id)
  WHERE upload_batch_id IS NOT NULL;

-- Race-safe per-actor-per-day batch_seq allocator.
-- Returns the next batch_seq for (actor, date) and creates the batch row.
-- pg_advisory_xact_lock keyed on hashtext(actor||date) serializes concurrent
-- callers so two simultaneous uploads never collide on batch_seq.
CREATE OR REPLACE FUNCTION public.next_upload_batch(
  p_actor_creator     TEXT,
  p_uploaded_by_label TEXT DEFAULT NULL,
  p_uploaded_by_user  UUID DEFAULT NULL,
  p_tz                TEXT DEFAULT 'Pacific/Auckland'
)
RETURNS public.lib_upload_batches AS $$
DECLARE
  v_date  DATE;
  v_seq   INT;
  v_batch public.lib_upload_batches;
BEGIN
  v_date := (NOW() AT TIME ZONE p_tz)::DATE;
  -- Lock the (actor, date) bucket so the count is stable
  PERFORM pg_advisory_xact_lock(hashtext(COALESCE(p_actor_creator, 'UNK') || '|' || v_date::TEXT));
  SELECT COALESCE(MAX(batch_seq), 0) + 1
    INTO v_seq
    FROM public.lib_upload_batches
   WHERE actor_creator = COALESCE(p_actor_creator, 'UNK')
     AND date_local    = v_date;
  INSERT INTO public.lib_upload_batches
    (uploaded_by_user_id, uploaded_by_label, actor_creator, date_local, batch_seq)
  VALUES
    (p_uploaded_by_user, p_uploaded_by_label, COALESCE(p_actor_creator, 'UNK'), v_date, v_seq)
  RETURNING * INTO v_batch;
  RETURN v_batch;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.next_upload_batch(TEXT, TEXT, UUID, TEXT) TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.lib_upload_batches TO authenticated;
GRANT SELECT ON public.lib_upload_batches TO anon;

-- Refresh the editing-queue view so it surfaces the new triage fields.
-- DROP+CREATE pattern matches migrations 084/086/103. All existing columns
-- preserved + new triage/batch columns added.
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
  -- is_overdue per Ben's 2026-05-31 rule (status='review' suppresses)
  (t.due_date IS NOT NULL
    AND t.due_date < CURRENT_DATE
    AND t.status NOT IN ('done', 'blocked', 'review')) AS is_overdue
FROM public.lib_editing_tasks t
LEFT JOIN public.lib_creative_editors  e ON e.id = t.editor_id
LEFT JOIN public.lib_creative_library  c ON c.id = t.creative_id;

GRANT SELECT ON public.lib_editing_queue TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
