-- 146: Google-Drive-style folders for the creative library.
--
-- Ben (2026-06-10): "I need a folder system so that I can batch and
-- organise edits done on the sales dashboard — currently it's hard to
-- tell which edits are for which angle and which offer."
--
-- One new table (lib_creative_folders, self-referencing parent_id for
-- nesting) plus a folder_id column on lib_creative_library. A creative
-- lives in at most one folder; folder_id NULL = library root, which is
-- also where every existing row stays, so nothing moves until the
-- operator starts filing things.
--
-- Delete semantics (enforced app-side + by the FKs): deleting a folder
-- deletes its subfolders (parent_id CASCADE) but never the clips —
-- creative.folder_id is ON DELETE SET NULL so orphaned clips fall back
-- to the root.

BEGIN;

CREATE TABLE IF NOT EXISTS public.lib_creative_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  parent_id   UUID REFERENCES public.lib_creative_folders(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lib_creative_folders_parent
  ON public.lib_creative_folders(parent_id);

-- Reject cycles (folder moved into its own subtree). UPDATE-only: a
-- freshly generated UUID can't already be anyone's ancestor, so INSERT
-- needs no walk. Single recursive query with a path guard, so even a
-- pre-existing cycle (e.g. two concurrent re-parents that raced past
-- each other — accepted risk for a two-admin internal tool) terminates
-- the walk instead of spinning the statement forever.
CREATE OR REPLACE FUNCTION public.lib_creative_folders_no_cycles() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'folder cannot be its own parent';
  END IF;
  IF EXISTS (
    WITH RECURSIVE anc AS (
      SELECT f.id, f.parent_id, ARRAY[f.id] AS path
      FROM public.lib_creative_folders f
      WHERE f.id = NEW.parent_id
      UNION ALL
      SELECT f.id, f.parent_id, anc.path || f.id
      FROM public.lib_creative_folders f
      JOIN anc ON f.id = anc.parent_id
      WHERE NOT f.id = ANY(anc.path)
    )
    SELECT 1 FROM anc WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'folder move would create a cycle';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lib_creative_folders_no_cycles ON public.lib_creative_folders;
CREATE TRIGGER trg_lib_creative_folders_no_cycles
  BEFORE UPDATE OF parent_id ON public.lib_creative_folders
  FOR EACH ROW EXECUTE FUNCTION public.lib_creative_folders_no_cycles();

-- updated_at — reuse the library's touch function (075).
DROP TRIGGER IF EXISTS trg_lib_creative_folders_updated_at ON public.lib_creative_folders;
CREATE TRIGGER trg_lib_creative_folders_updated_at
  BEFORE UPDATE ON public.lib_creative_folders
  FOR EACH ROW EXECUTE FUNCTION public.touch_creative_library_updated_at();

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS folder_id UUID
    REFERENCES public.lib_creative_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lib_creative_library_folder
  ON public.lib_creative_library(folder_id);

-- Atomic folder delete: release every clip in the subtree to the deleted
-- folder's parent, then delete the folder (subfolders go via CASCADE) —
-- one transaction, subtree computed server-side. Doing this client-side
-- as two statements risked a half-applied delete (clips moved, folder
-- still there) and missed subfolders created by another client since the
-- caller's last load.
CREATE OR REPLACE FUNCTION public.lib_delete_creative_folder(p_folder_id UUID)
RETURNS VOID AS $$
DECLARE
  v_parent UUID;
BEGIN
  SELECT parent_id INTO v_parent
  FROM public.lib_creative_folders WHERE id = p_folder_id;
  IF NOT FOUND THEN RETURN; END IF;  -- already gone — deleting is idempotent

  WITH RECURSIVE sub AS (
    SELECT id, ARRAY[id] AS path FROM public.lib_creative_folders WHERE id = p_folder_id
    UNION ALL
    SELECT f.id, sub.path || f.id
    FROM public.lib_creative_folders f
    JOIN sub ON f.parent_id = sub.id
    WHERE NOT f.id = ANY(sub.path)
  )
  UPDATE public.lib_creative_library c
  SET folder_id = v_parent
  WHERE c.folder_id IN (SELECT id FROM sub);

  DELETE FROM public.lib_creative_folders WHERE id = p_folder_id;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION public.lib_delete_creative_folder(UUID) TO authenticated, anon;

-- RLS — allow-all, matching the rest of the lib_* surface (075).
ALTER TABLE public.lib_creative_folders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lib_creative_folders: read"  ON public.lib_creative_folders;
DROP POLICY IF EXISTS "lib_creative_folders: write" ON public.lib_creative_folders;
CREATE POLICY "lib_creative_folders: read"  ON public.lib_creative_folders FOR SELECT USING (TRUE);
CREATE POLICY "lib_creative_folders: write" ON public.lib_creative_folders FOR ALL    USING (TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lib_creative_folders TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
