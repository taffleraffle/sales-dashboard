-- generated_scripts.script_type + .angle_slug for the template-based
-- creative-generate-script v2 (Ben 2026-05-31).
--
-- The Edge Function saves new template-mode generations with these
-- fields tagged so the AdsGenerator UI can filter the history table
-- by Hook / Body / Joined and by angle. The legacy attribute-based
-- save path leaves them NULL.

BEGIN;

ALTER TABLE public.generated_scripts
  ADD COLUMN IF NOT EXISTS script_type TEXT,
  ADD COLUMN IF NOT EXISTS angle_slug  TEXT REFERENCES public.script_angles(slug) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_generated_scripts_angle
  ON public.generated_scripts (angle_slug);

CREATE INDEX IF NOT EXISTS idx_generated_scripts_script_type
  ON public.generated_scripts (script_type);

NOTIFY pgrst, 'reload schema';

COMMIT;
