-- 121_angle_type_three_buckets.sql
-- Extend script_angles.angle_type from {problem, desire, legacy} to
-- {problem, circumstance, outcome, desire, legacy} (Ben 2026-06-01).
--
-- Ben wants three angle buckets per generation instead of two:
--   - problem      what the prospect is stuck on (existing)
--   - circumstance the situation / identity moment they're in
--   - outcome      what they want (replaces / aliases 'desire')
--
-- 'desire' is kept as a synonym so existing rows + Edge Function code
-- paths that produce 'desire' don't error. UI will treat desire ==
-- outcome (same color, same bucket label). New generations will
-- produce 'outcome'.

ALTER TABLE public.script_angles
  DROP CONSTRAINT IF EXISTS script_angles_angle_type_check;

ALTER TABLE public.script_angles
  ADD CONSTRAINT script_angles_angle_type_check
  CHECK (angle_type IN ('problem', 'circumstance', 'outcome', 'desire', 'legacy'));

COMMENT ON COLUMN public.script_angles.angle_type IS
  'Bucket the angle lives in. problem = pain, circumstance = situation/identity, outcome = desire/end-state. desire is kept as a legacy synonym for outcome. legacy = pre-migration-109 rows.';

NOTIFY pgrst, 'reload schema';
