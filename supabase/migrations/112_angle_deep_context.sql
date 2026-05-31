-- 112_angle_deep_context.sql
-- Deeper context per angle (Ben 2026-05-31).
--
-- Each generated problem/desire angle now carries:
--   - why_it_matters     : prose paragraph on consequences of not solving,
--                          deeper anxiety, what the prospect has tried.
--   - evidence_examples  : 2-3 concrete situational moments ("refreshing the
--                          CRM at 9pm hoping a call came in").
--   - sources            : real grounding citations used during generation,
--                          shape [{title, url, snippet}]. Empty when the
--                          generation ran without web grounding (e.g. when
--                          SERPER_API_KEY is unset on the Edge Function).
--
-- All three columns are nullable / default-empty so existing rows are
-- valid and the Edge Function can populate them on next generation.

ALTER TABLE public.script_angles
  ADD COLUMN IF NOT EXISTS why_it_matters     TEXT,
  ADD COLUMN IF NOT EXISTS evidence_examples  TEXT[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sources            JSONB   DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.script_angles.why_it_matters    IS 'Prose paragraph: consequences of not solving, deeper anxiety, what they''ve tried. Generated alongside the angle.';
COMMENT ON COLUMN public.script_angles.evidence_examples IS 'Concrete situational examples — 2-3 per angle. e.g. "Refreshing the CRM at 9pm hoping a call came in".';
COMMENT ON COLUMN public.script_angles.sources           IS 'Real grounding sources used during generation: [{title, url, snippet}]. Empty when SERPER_API_KEY unset or search returned nothing.';

-- Reload PostgREST so the new columns are exposed via the REST API.
NOTIFY pgrst, 'reload schema';
