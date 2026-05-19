-- 080_creative_library_simplify.sql
--
-- UI dump-and-replace based on Ben's 2026-05-20 feedback:
--   "The status I just want is raw and approved or raw and edited."
--   "We need to have hooks, bodies, and joined"
--   "Tagging the offer, like if it's a restoration, that would be great."
--   "Marking if it's been run before, like has it been run, that needs to be done"
--
-- Schema changes:
--   1. Collapse status enum from 6 values to 2:  raw | edited
--      (in_edit, review, approved, live, archived  ->  edited)
--   2. Rename type 'Full Video' to 'Joined' (Hook+Body merge concept).
--      Other types unchanged: Hook, Body, Testimony, unknown.
--   3. Add offer_slug (FK-ish text -> offers.slug)
--   4. Add has_been_run boolean (Ben needs to see this in lists)
--
-- Data migrations run in-place. No new indexes; offer_slug is rarely
-- filtered by alone so we lean on the existing type/status indexes.

BEGIN;

-- 1. Status collapse
UPDATE public.lib_creative_library
SET status = 'edited'
WHERE status IN ('in_edit', 'review', 'approved', 'live', 'archived');

-- 2. Type rename: Full Video -> Joined
UPDATE public.lib_creative_library
SET type = 'Joined'
WHERE type = 'Full Video';

-- 3. New columns
ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS offer_slug   TEXT,
  ADD COLUMN IF NOT EXISTS has_been_run BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_lib_creative_library_offer_slug   ON public.lib_creative_library(offer_slug);
CREATE INDEX IF NOT EXISTS idx_lib_creative_library_has_been_run ON public.lib_creative_library(has_been_run);

NOTIFY pgrst, 'reload schema';

COMMIT;
