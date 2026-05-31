-- Creative-library naming overhaul.
--
-- Adds the columns needed for the new bulletproof display_name format:
--   {TYPE}-{OFFER}-{MESSAGING}-{ACTOR}-T{NN}.{ext}
--   e.g. BODY-ACCOUNTANT-STOP-PAYING-FOR-LEADS-OSO-T01.mp4
--
-- Old canonical_name is preserved verbatim in legacy_canonical for audit.
-- App code reads display_name COALESCE canonical_name COALESCE name, so
-- nothing breaks if display_name is NULL during the backfill window.
--
-- Migration is additive only: no DROP, no rename, no constraint that could
-- reject existing rows.

BEGIN;

ALTER TABLE public.lib_creative_library
  -- AI-generated angle ("STOP-PAYING-FOR-LEADS") — 4-10 word kebab slug
  -- derived from the transcript by creative-library-describe.
  ADD COLUMN IF NOT EXISTS messaging_angle TEXT,

  -- Coordinator / admin override. Read priority: override -> ai -> NULL.
  -- AI value never lost so we can compare-and-revert.
  ADD COLUMN IF NOT EXISTS messaging_angle_override TEXT,

  -- Second creator slot for JOINED clips (hook actor + body actor merged).
  -- For single-creator rows this stays NULL. Filename appends it after
  -- creator: "-ERIC-NATALIE-".
  ADD COLUMN IF NOT EXISTS second_creator TEXT,

  -- Take number computed at insert / describe time via count(*) + 1 over
  -- rows matching (offer_slug, messaging_angle, creator). No more parsing
  -- from the prior filename (which produced duplicate -T01s).
  ADD COLUMN IF NOT EXISTS take_number INT,

  -- md5(transcript || visual_description) prefix. Disambiguates rows when
  -- every other token collides. Filename surfaces it only when there's
  -- a genuine collision; otherwise omitted.
  ADD COLUMN IF NOT EXISTS content_hash TEXT,

  -- The new bulletproof name. Filename of the downloaded file. UI reads
  -- this first; falls back to canonical_name / name during the backfill
  -- window so the editor timeline never goes blank.
  ADD COLUMN IF NOT EXISTS display_name TEXT,

  -- Snapshot of canonical_name at migration time. Audit trail so we can
  -- reconcile old download links Ben shared externally.
  ADD COLUMN IF NOT EXISTS legacy_canonical TEXT,

  -- Optional project tag (replaces the "Project name" bulk-rename input
  -- which used to overwrite canonical_name with free text).
  ADD COLUMN IF NOT EXISTS project_tag TEXT;

-- One-shot copy of current canonical_name into legacy_canonical so we never
-- lose the historical mess. Idempotent: only writes when legacy is NULL,
-- so re-running this migration is safe.
UPDATE public.lib_creative_library
SET legacy_canonical = canonical_name
WHERE legacy_canonical IS NULL
  AND canonical_name IS NOT NULL;

-- Uniqueness backstop for display_name. PARTIAL index (NULLs excluded) so
-- the backfill can populate gradually without tripping on NULL collisions.
-- Once backfill is complete, NULLs disappear and the partial index becomes
-- effectively total.
CREATE UNIQUE INDEX IF NOT EXISTS lib_creative_library_display_name_unique
  ON public.lib_creative_library (display_name)
  WHERE display_name IS NOT NULL;

-- Index for fast take_number computation (count(*) WHERE offer+angle+creator match).
CREATE INDEX IF NOT EXISTS lib_creative_library_naming_lookup
  ON public.lib_creative_library (offer_slug, messaging_angle, creator);

-- Refresh the editing-queue view to surface display_name + legacy_canonical
-- + messaging_angle + second_creator while preserving every column the UI
-- already reads. Pattern matches migrations 084 / 086 (DROP + CREATE).
DROP VIEW IF EXISTS public.lib_editing_queue;

CREATE VIEW public.lib_editing_queue AS
SELECT
  -- Existing task columns (preserved from migration 086)
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
  -- Existing editor columns
  e.id                       AS editor_id,
  e.name                     AS editor_name,
  e.slug                     AS editor_slug,
  e.color                    AS editor_color,
  -- Existing creative columns
  c.id                       AS creative_id,
  c.name                     AS creative_name,
  c.canonical_name           AS creative_canonical_name,
  c.type                     AS creative_type,
  c.creator                  AS creative_creator,
  c.thumbnail_url,
  c.preview_url,
  c.drive_url,
  -- Surface final_cut_url so the editor task pane can prefer the editor's
  -- finished cut over the raw source for downloads. The pre-103 view never
  -- projected this, so task pane downloads silently fell through to
  -- drive_url / preview_url even after migration 086 was supposed to fix it
  -- (download-quality-audit.md §1 row 3, Ben 2026-05-31).
  c.final_cut_url            AS final_cut_url,
  c.v21_script_id,
  c.status                   AS creative_status,
  -- NEW: naming overhaul columns surfaced to every queue consumer
  c.display_name             AS creative_display_name,
  c.legacy_canonical         AS creative_legacy_canonical,
  c.messaging_angle          AS creative_messaging_angle,
  c.messaging_angle_override AS creative_messaging_angle_override,
  c.second_creator           AS creative_second_creator,
  c.offer_slug               AS creative_offer_slug,
  c.take_number              AS creative_take_number,
  c.project_tag              AS creative_project_tag,
  -- is_overdue: only TRUE when the EDITOR is actually blocking the task.
  -- Past states that exclude 'review' (Ben's 2026-05-31 complaint): when
  -- an editor has submitted a cut, the task is on the COORDINATOR's plate,
  -- not the editor's — flagging it as OVD on the editor's timeline lies
  -- about who's blocking and made it impossible to tell at a glance
  -- whether a submission had been made. 'review' joins 'done' and 'blocked'
  -- as states that suppress the overdue flag. 'needs_revision' is still
  -- the editor's plate (coordinator rejected, editor must redo) so OVD
  -- still applies to that state.
  (t.due_date IS NOT NULL
    AND t.due_date < CURRENT_DATE
    AND t.status NOT IN ('done', 'blocked', 'review')) AS is_overdue
FROM public.lib_editing_tasks t
LEFT JOIN public.lib_creative_editors  e ON e.id = t.editor_id
LEFT JOIN public.lib_creative_library  c ON c.id = t.creative_id;

GRANT SELECT ON public.lib_editing_queue TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
