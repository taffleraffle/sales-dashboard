-- Migration 142: fix the electrician-Maps angle qualifiers (Ben 2026-06-09).
--
-- All 14 opt-electricians-maps-* angles currently store this qualifier:
--   "Licensed electrical contractors doing $20K+/month who want to rank in the top 3"
--
-- Two problems Ben surfaced from the live script writer output:
--   (a) "Licensed" is fluff — anyone OPT would serve is licensed; saying it
--       in copy reads like a TV-lawyer ad ("we operate ethically too!").
--       The script writer was faithfully baking it into every hook.
--   (b) The $20K floor is wrong — OPT's actual minimum is $50K+/month. The
--       cap was bleeding into hook openers like "Electricians doing $20K+
--       a month — your phone's probably ringing for the wrong jobs."
--
-- This is a data fix only — the Edge Function reads qualifier verbatim into
-- the prompt context, so updating the row immediately changes every future
-- script run. Idempotent (uses an explicit WHERE on the bad string).

BEGIN;

UPDATE public.script_angles
   SET qualifier   = 'Electricians doing $50K+/month who want to rank in the top 3',
       updated_at  = NOW(),
       notes       = COALESCE(notes, '') ||
                     E'\n[2026-06-09] Qualifier updated: dropped "Licensed" (fluff), $20K → $50K (real OPT floor). See migration 142.'
 WHERE slug LIKE 'opt-electricians-maps-%'
   AND qualifier = 'Licensed electrical contractors doing $20K+/month who want to rank in the top 3';

-- Sanity check: report how many rows changed (visible in SQL editor result).
SELECT slug, qualifier FROM public.script_angles
 WHERE slug LIKE 'opt-electricians-maps-%'
 ORDER BY slug;

NOTIFY pgrst, 'reload schema';

COMMIT;
