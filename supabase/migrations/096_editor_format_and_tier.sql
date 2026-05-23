-- Editor format + tier columns.
--
-- format: which type of cuts the editor specializes in
--   'shorts' = vertical 9:16 short-form (under 90s)
--   'long'   = horizontal 16:9 long-form / YouTube-style
--   'both'   = handles both formats
-- Default 'both' so legacy rows don't filter out of pickers unexpectedly.
--
-- tier: permission/seniority level
--   'admin'  = can manage other editors, see all admin views (currently
--              unused for auth — Ben is the only admin and uses the
--              main dashboard route, not /editor-view)
--   'editor' = standard editor
-- Default 'editor'.

ALTER TABLE public.lib_creative_editors
  ADD COLUMN IF NOT EXISTS format TEXT
    CHECK (format IN ('shorts', 'long', 'both'))
    DEFAULT 'both' NOT NULL;

ALTER TABLE public.lib_creative_editors
  ADD COLUMN IF NOT EXISTS tier TEXT
    CHECK (tier IN ('admin', 'editor'))
    DEFAULT 'editor' NOT NULL;

NOTIFY pgrst, 'reload schema';
