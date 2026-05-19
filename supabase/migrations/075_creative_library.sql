-- 075_creative_library.sql
--
-- Creative library for raw + edited footage tracking.
-- Replaces the static OPT_Creative_Matrix.xlsx workflow with a live
-- in-app surface at /sales/ads/creative/library.
--
-- Three tables:
--   lib_creative_library  — every video clip (raw, edited, approved)
--   lib_editors           — short-form editor roster
--   lib_editing_tasks     — assignments + status pipeline
--
-- Plus a view (lib_editing_queue) that joins all three for the
-- "what is everyone working on" tab.

BEGIN;

-- =========================================================================
-- lib_creative_editors — short-form editor roster
-- (separate from the existing lib_editors table which is for sales-side
-- review editors with a different schema)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.lib_creative_editors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.lib_creative_editors (name, slug) VALUES
  ('Ahmed',       'ahmed'),
  ('Mohamed',     'mohamed'),
  ('Dean',        'dean'),
  ('Unassigned',  'unassigned')
ON CONFLICT (slug) DO NOTHING;

-- =========================================================================
-- lib_creative_library — every clip (the main library)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.lib_creative_library (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity
  name                  TEXT NOT NULL,
  type                  TEXT NOT NULL DEFAULT 'unknown',
                        -- Hook | Body | Full Video | Frame | Client Testimonial
                        -- | Podcast | Client Footage | Other | unknown
  creator               TEXT,
                        -- OSO | SOFIA | NATALIE | JARED | BEN | MAKE-UGC
                        -- | ERIC (client) | ADAM (client) | MORGAN (client) etc.
  -- Storage
  drive_id              TEXT,
  drive_url             TEXT,
  thumbnail_url         TEXT,
  size_mb               NUMERIC,
  duration_seconds      NUMERIC,
  -- Content / tagging
  v21_script_id         TEXT,
  v21_match_confidence  NUMERIC,
  transcript            TEXT,
  source_bucket         TEXT,
  -- Production lifecycle
  status                TEXT NOT NULL DEFAULT 'raw',
                        -- raw | in_edit | review | approved | live | archived
  exclude_from_library  BOOLEAN NOT NULL DEFAULT FALSE,
  notes                 TEXT,
  added_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lib_creative_library_type           ON public.lib_creative_library(type);
CREATE INDEX IF NOT EXISTS idx_lib_creative_library_creator        ON public.lib_creative_library(creator);
CREATE INDEX IF NOT EXISTS idx_lib_creative_library_v21_script_id  ON public.lib_creative_library(v21_script_id);
CREATE INDEX IF NOT EXISTS idx_lib_creative_library_status         ON public.lib_creative_library(status);
CREATE INDEX IF NOT EXISTS idx_lib_creative_library_added_at       ON public.lib_creative_library(added_at DESC);

-- =========================================================================
-- lib_editing_tasks — assignments + pipeline
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.lib_editing_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id   UUID NOT NULL REFERENCES public.lib_creative_library(id) ON DELETE CASCADE,
  editor_id     UUID REFERENCES public.lib_creative_editors(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'queued',
                -- queued | in_progress | review | done | blocked
  priority      TEXT NOT NULL DEFAULT 'P2 - Medium',
                -- P1 - High | P2 - Medium | P3 - Low
  task_type     TEXT,
                -- rough_cut | final_cut | patch_hook_body | thumbnail | revision | etc.
  -- Timeline
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  due_date      DATE,
  completed_at  TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lib_editing_tasks_creative_id ON public.lib_editing_tasks(creative_id);
CREATE INDEX IF NOT EXISTS idx_lib_editing_tasks_editor_id   ON public.lib_editing_tasks(editor_id);
CREATE INDEX IF NOT EXISTS idx_lib_editing_tasks_status      ON public.lib_editing_tasks(status);
CREATE INDEX IF NOT EXISTS idx_lib_editing_tasks_due_date    ON public.lib_editing_tasks(due_date);

-- updated_at trigger for both tables
CREATE OR REPLACE FUNCTION public.touch_creative_library_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lib_creative_library_updated_at ON public.lib_creative_library;
CREATE TRIGGER trg_lib_creative_library_updated_at
  BEFORE UPDATE ON public.lib_creative_library
  FOR EACH ROW EXECUTE FUNCTION public.touch_creative_library_updated_at();

DROP TRIGGER IF EXISTS trg_lib_editing_tasks_updated_at ON public.lib_editing_tasks;
CREATE TRIGGER trg_lib_editing_tasks_updated_at
  BEFORE UPDATE ON public.lib_editing_tasks
  FOR EACH ROW EXECUTE FUNCTION public.touch_creative_library_updated_at();

-- =========================================================================
-- lib_editing_queue — view joining all three for the queue tab
-- =========================================================================
CREATE OR REPLACE VIEW public.lib_editing_queue AS
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
  c.id              AS creative_id,
  c.name            AS creative_name,
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
LEFT JOIN public.lib_creative_editors           e ON e.id = t.editor_id
LEFT JOIN public.lib_creative_library  c ON c.id = t.creative_id;

-- =========================================================================
-- Storage bucket for thumbnails (public-read)
-- =========================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('creative-thumbnails', 'creative-thumbnails', TRUE, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = TRUE;

-- =========================================================================
-- RLS — allow-all for now (internal dashboard pattern)
-- =========================================================================
ALTER TABLE public.lib_creative_editors           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lib_creative_library  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lib_editing_tasks     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lib_creative_editors: read"           ON public.lib_creative_editors;
DROP POLICY IF EXISTS "lib_creative_editors: write"          ON public.lib_creative_editors;
DROP POLICY IF EXISTS "lib_creative_library: read"  ON public.lib_creative_library;
DROP POLICY IF EXISTS "lib_creative_library: write" ON public.lib_creative_library;
DROP POLICY IF EXISTS "lib_editing_tasks: read"     ON public.lib_editing_tasks;
DROP POLICY IF EXISTS "lib_editing_tasks: write"    ON public.lib_editing_tasks;

CREATE POLICY "lib_creative_editors: read"           ON public.lib_creative_editors           FOR SELECT USING (TRUE);
CREATE POLICY "lib_creative_editors: write"          ON public.lib_creative_editors           FOR ALL    USING (TRUE);
CREATE POLICY "lib_creative_library: read"  ON public.lib_creative_library  FOR SELECT USING (TRUE);
CREATE POLICY "lib_creative_library: write" ON public.lib_creative_library  FOR ALL    USING (TRUE);
CREATE POLICY "lib_editing_tasks: read"     ON public.lib_editing_tasks     FOR SELECT USING (TRUE);
CREATE POLICY "lib_editing_tasks: write"    ON public.lib_editing_tasks     FOR ALL    USING (TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lib_creative_editors           TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lib_creative_library  TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lib_editing_tasks     TO authenticated, anon;
GRANT SELECT                         ON public.lib_editing_queue     TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
