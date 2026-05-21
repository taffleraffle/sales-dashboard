-- 092_visual_description.sql
--
-- The identify-actor Edge Function calls Claude Vision on each thumbnail
-- to (a) identify the OPT creator visible in the frame against a set of
-- reference thumbnails, and (b) return a short visual description of the
-- frame so even non-person creatives (screencasts, logo cards) get a
-- searchable line. We store that description here so the matrix can show
-- it as a tooltip / search term, and so canonical_name can fall back to
-- it when creator is UNK.

BEGIN;

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS visual_description TEXT;

NOTIFY pgrst, 'reload schema';

COMMIT;
