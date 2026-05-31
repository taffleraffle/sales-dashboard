-- Add pain_points to script_angles so Shape C (Pain anchor) and other
-- pain-leading shapes have concrete situations to anchor to — instead of
-- defaulting to generic competitor language. Ben 2026-05-31 seeded the
-- second angle (rank-1-in-ai) with AI-search-disintermediation pain
-- research and asked the generator to use it directly.

BEGIN;

ALTER TABLE public.script_angles
  ADD COLUMN IF NOT EXISTS pain_points TEXT[] DEFAULT '{}';

NOTIFY pgrst, 'reload schema';

COMMIT;
