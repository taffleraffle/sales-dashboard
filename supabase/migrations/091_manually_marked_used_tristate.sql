-- 091_manually_marked_used_tristate.sql
--
-- The 'EDITED RAW' classification combines three signals: the manual
-- override flag, the type='Hook' fast-path, and the transcript-overlap
-- heuristic. With manually_marked_used as a NOT-NULL BOOLEAN there was
-- no way to express 'override the heuristic — this row is NOT used'.
-- Ben hit this when he clicked RAW on a Hook row and nothing changed
-- (the Hook fast-path kept classifying it as EDITED RAW).
--
-- Tri-state: NULL = inherit heuristic, TRUE = force used, FALSE =
-- force unused. The 176 rows that were FALSE-by-default get migrated
-- to NULL so existing heuristic behaviour is preserved. The 13 rows
-- Ben actually marked TRUE stay TRUE.

BEGIN;

ALTER TABLE public.lib_creative_library
  ALTER COLUMN manually_marked_used DROP NOT NULL;

ALTER TABLE public.lib_creative_library
  ALTER COLUMN manually_marked_used DROP DEFAULT;

-- Backfill: every FALSE was a default-never-touched value, so push it
-- to NULL so the heuristic kicks in for those rows. Already-TRUE rows
-- (operator clicked EDITED RAW) stay TRUE.
UPDATE public.lib_creative_library
SET manually_marked_used = NULL
WHERE manually_marked_used = FALSE;

NOTIFY pgrst, 'reload schema';

COMMIT;
