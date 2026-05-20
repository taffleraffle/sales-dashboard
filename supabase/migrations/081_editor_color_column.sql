-- 081_editor_color_column.sql
--
-- Adds an optional manual color override on lib_creative_editors. When
-- NULL (default), the UI falls back to the hash-derived color from
-- editorColor(slug). When set, the UI uses this hex value everywhere
-- the editor appears (lanes, dropdowns, kanban cards, timeline bars).
--
-- Lets operators resolve color collisions between editors with similar
-- slug hashes (e.g. two editors that both hash to the same EDITOR_COLORS
-- palette index).

BEGIN;

ALTER TABLE public.lib_creative_editors
  ADD COLUMN IF NOT EXISTS color TEXT;

NOTIFY pgrst, 'reload schema';

COMMIT;
