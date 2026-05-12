-- 040_clips_funnel_thumbnail_editors.sql
-- Creative Testing → Clips overhaul. Three additions:
--
--   1. funnel_position column on library.clips. Top-of-funnel / Middle / Bottom,
--      independent of clip_type. A "hook" clip can be either TOF or MOF; a
--      "body" clip can be MOF or BOF. We need both dimensions for organization.
--
--   2. thumbnail_url column on library.clips. Holds a poster frame extracted
--      client-side at upload time so the card grid renders previews without
--      hitting Supabase Storage per row.
--
--   3. library.editors table. Editors are people who cut + colour clips
--      (currently free-text on clips.editor). Move to a managed entity so the
--      dropdown stays clean and "add new editor" is a real operation.
--
-- Also seeds ADAM, ERIC, MORGAN into library.components (already referenced as
-- creators in the AdsClips KNOWN_CREATORS list but never seeded).
--
-- New RPCs:
--   lib_editor_add(p_editor TEXT)          → upsert editor
--   lib_editor_archive(p_editor TEXT)      → soft-archive
--   lib_creator_add(p_id, p_label TEXT)    → upsert new creator component
--   lib_clip_upsert(..., funnel_position, thumbnail_url, …)  ← extended signature
--
-- Idempotent. Apply via supabase db push.

BEGIN;

-- ─── 1 · library.clips schema extensions ───────────────────────────
ALTER TABLE library.clips
  ADD COLUMN IF NOT EXISTS funnel_position TEXT
    CHECK (funnel_position IS NULL OR funnel_position IN ('top','middle','bottom')),
  ADD COLUMN IF NOT EXISTS thumbnail_url   TEXT;

CREATE INDEX IF NOT EXISTS idx_clips_funnel_position
  ON library.clips(funnel_position) WHERE funnel_position IS NOT NULL;

-- Recreate the public read view so the new columns are exposed to PostgREST.
DROP VIEW IF EXISTS public.lib_clips CASCADE;
CREATE VIEW public.lib_clips
WITH (security_invoker = on)
AS SELECT * FROM library.clips;
GRANT SELECT ON public.lib_clips TO anon, authenticated;

-- ─── 2 · library.editors entity ────────────────────────────────────
CREATE TABLE IF NOT EXISTS library.editors (
  editor_id  TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed from any editors already in lib_clips so we don't lose history.
INSERT INTO library.editors (editor_id, label)
SELECT DISTINCT
  upper(trim(editor)) AS editor_id,
  trim(editor)        AS label
FROM library.clips
WHERE editor IS NOT NULL AND length(trim(editor)) > 0
ON CONFLICT (editor_id) DO NOTHING;

DROP VIEW IF EXISTS public.lib_editors CASCADE;
CREATE VIEW public.lib_editors
WITH (security_invoker = on)
AS SELECT editor_id, label, status FROM library.editors WHERE status = 'active' ORDER BY label;
GRANT SELECT ON public.lib_editors TO anon, authenticated;

-- ─── 3 · Seed missing creators (ADAM, ERIC, MORGAN) ────────────────
INSERT INTO library.components (component_id, type, label, description, status) VALUES
  ('ADAM',   'creator', 'Adam',   'Adam — UGC creator',                       'ready'),
  ('ERIC',   'creator', 'Eric',   'Eric — restoration client testimonial',     'ready'),
  ('MORGAN', 'creator', 'Morgan', 'Morgan — UGC creator',                      'ready')
ON CONFLICT (component_id) DO UPDATE SET
  type   = EXCLUDED.type,
  label  = EXCLUDED.label,
  status = EXCLUDED.status;

-- ─── 4 · RPCs ──────────────────────────────────────────────────────

-- Add (or upsert) a new editor. Returns the row.
CREATE OR REPLACE FUNCTION public.lib_editor_add(p_editor TEXT)
RETURNS library.editors
LANGUAGE plpgsql SECURITY DEFINER SET search_path = library, public AS $$
DECLARE
  ed TEXT := trim(p_editor);
  out_row library.editors;
BEGIN
  IF ed IS NULL OR length(ed) = 0 THEN
    RAISE EXCEPTION 'editor name must not be empty';
  END IF;
  INSERT INTO library.editors (editor_id, label, status)
  VALUES (upper(ed), ed, 'active')
  ON CONFLICT (editor_id) DO UPDATE SET status = 'active', label = EXCLUDED.label
  RETURNING * INTO out_row;
  RETURN out_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.lib_editor_archive(p_editor TEXT)
RETURNS library.editors
LANGUAGE plpgsql SECURITY DEFINER SET search_path = library, public AS $$
DECLARE
  out_row library.editors;
BEGIN
  UPDATE library.editors
  SET status = 'archived'
  WHERE editor_id = upper(trim(p_editor))
  RETURNING * INTO out_row;
  RETURN out_row;
END;
$$;

-- Add (or upsert) a new creator. Lives in library.components for parity with
-- the existing seeded creators.
CREATE OR REPLACE FUNCTION public.lib_creator_add(p_id TEXT, p_label TEXT)
RETURNS library.components
LANGUAGE plpgsql SECURITY DEFINER SET search_path = library, public AS $$
DECLARE
  cid TEXT := upper(trim(p_id));
  lbl TEXT := trim(p_label);
  out_row library.components;
BEGIN
  IF cid IS NULL OR length(cid) = 0 THEN
    RAISE EXCEPTION 'creator id must not be empty';
  END IF;
  INSERT INTO library.components (component_id, type, label, description, status)
  VALUES (cid, 'creator', COALESCE(NULLIF(lbl,''), cid), NULL, 'ready')
  ON CONFLICT (component_id) DO UPDATE SET
    type   = 'creator',
    label  = COALESCE(NULLIF(EXCLUDED.label,''), library.components.label),
    status = 'ready'
  RETURNING * INTO out_row;
  RETURN out_row;
END;
$$;

-- Extend lib_clip_upsert to take funnel_position + thumbnail_url. Existing
-- callers that pass the old positional args keep working because the new
-- params come at the end with defaults.
CREATE OR REPLACE FUNCTION public.lib_clip_upsert(
  p_clip_id          TEXT,
  p_clip_type        TEXT,
  p_section          TEXT DEFAULT NULL,
  p_description      TEXT DEFAULT NULL,
  p_creator_id       TEXT DEFAULT NULL,
  p_editor           TEXT DEFAULT NULL,
  p_priority         TEXT DEFAULT NULL,
  p_duration_sec     INTEGER DEFAULT NULL,
  p_source_file_url  TEXT DEFAULT NULL,
  p_source_file_name TEXT DEFAULT NULL,
  p_notes            TEXT DEFAULT NULL,
  p_funnel_position  TEXT DEFAULT NULL,
  p_thumbnail_url    TEXT DEFAULT NULL
) RETURNS library.clips
LANGUAGE plpgsql SECURITY DEFINER SET search_path = library, public
AS $$
DECLARE
  out_row library.clips;
BEGIN
  INSERT INTO library.clips (
    clip_id, clip_type, section, description, creator_id, editor, priority,
    duration_sec, source_file_url, source_file_name, notes,
    funnel_position, thumbnail_url
  ) VALUES (
    p_clip_id, p_clip_type, p_section, p_description, p_creator_id, p_editor,
    p_priority, p_duration_sec, p_source_file_url, p_source_file_name, p_notes,
    p_funnel_position, p_thumbnail_url
  )
  ON CONFLICT (clip_id) DO UPDATE SET
    clip_type        = EXCLUDED.clip_type,
    section          = EXCLUDED.section,
    description      = EXCLUDED.description,
    creator_id       = EXCLUDED.creator_id,
    editor           = EXCLUDED.editor,
    priority         = EXCLUDED.priority,
    duration_sec     = EXCLUDED.duration_sec,
    source_file_url  = EXCLUDED.source_file_url,
    source_file_name = EXCLUDED.source_file_name,
    notes            = EXCLUDED.notes,
    funnel_position  = EXCLUDED.funnel_position,
    thumbnail_url    = COALESCE(EXCLUDED.thumbnail_url, library.clips.thumbnail_url),
    updated_at       = NOW()
  RETURNING * INTO out_row;
  RETURN out_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lib_editor_add(TEXT)         TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lib_editor_archive(TEXT)     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lib_creator_add(TEXT, TEXT)  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lib_clip_upsert(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT
) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
