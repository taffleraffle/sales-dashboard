-- script_angles: angle_type + prospect_voice + hook_build_sketch.
-- Ben 2026-05-31: the /generate page overhaul introduces a "Messaging"
-- mode that generates angles (problems + desires) for an offer and
-- auto-saves them to the angle library. To support that, angles need:
--   - angle_type: classification ('problem' | 'desire' | 'legacy')
--   - prospect_voice: the visceral first-person phrasing the angle
--                     comes from (e.g. "Bench is eating my bookkeeping
--                     clients"). Distinct from `qualifier` (the
--                     audience-filter line) and `name` (the title).
--   - hook_build_sketch: one-line Claude-written description of how
--                       this angle becomes a hook — which shape fits,
--                       what the opening posture is. Used in the UI
--                       to communicate the angle's structural
--                       implication at a glance.
--
-- All existing angles (rank-1-in-ai, becoming-1-in-city) get
-- angle_type='legacy' so the UI can label them as the mechanism-led
-- format vs new P/D-led format.

BEGIN;

ALTER TABLE public.script_angles
  ADD COLUMN IF NOT EXISTS angle_type        TEXT,
  ADD COLUMN IF NOT EXISTS prospect_voice    TEXT,
  ADD COLUMN IF NOT EXISTS hook_build_sketch TEXT;

-- Backfill existing rows to 'legacy' so the picker can distinguish them
-- from new P/D-classified angles.
UPDATE public.script_angles
SET angle_type = 'legacy'
WHERE angle_type IS NULL;

-- Constrain to the three valid values going forward.
ALTER TABLE public.script_angles
  DROP CONSTRAINT IF EXISTS script_angles_type_check;
ALTER TABLE public.script_angles
  ADD CONSTRAINT script_angles_type_check
  CHECK (angle_type IN ('problem', 'desire', 'legacy'));

CREATE INDEX IF NOT EXISTS idx_script_angles_type
  ON public.script_angles (angle_type, active);

NOTIFY pgrst, 'reload schema';

COMMIT;
