-- 117_proof_character_types.sql
-- Add proof_type column to script_proof_characters (Ben 2026-06-01).
--
-- Eugene Schwartz's hierarchy of proof — what convinces the prospect that
-- the mechanism + claim are real. The original schema only modelled
-- "named character with one-line result" (proof_type = 'case_study').
-- Real direct-response copy uses 5-6 kinds of proof in rotation:
--
--   case_study       Named client + result    "Eric — closed $215K in 90 days"
--   testimonial      Direct quote             "Closing rate doubled in week 2." — Mark, plumber
--   statistic        Numeric data point       "67% of restoration owners burn out on HomeAdvisor in y2"
--   authority        Expert / industry source "Roto-Rooter's own franchise manual recommends..."
--   demonstration    Show-not-tell mechanic   "Before vs after at month-end: $14k → $48k MRR"
--   social_volume    Aggregate-count proof    "Across 38 restoration companies in 2024"
--   comparison       Vs alternative           "Vs HomeAdvisor: 3.2x bookings, 1/4 the cost"
--
-- The Edge Function generator picks one proof per script and rotates so a
-- batch isn't 10 different "Eric did X" lines. UI lets the operator add
-- multiple proof types per angle.

ALTER TABLE public.script_proof_characters
  ADD COLUMN IF NOT EXISTS proof_type TEXT NOT NULL DEFAULT 'case_study';

-- Tag existing rows as case_study (the original shape).
UPDATE public.script_proof_characters
  SET proof_type = 'case_study'
  WHERE proof_type IS NULL OR proof_type = '';

-- Soft-validate via CHECK so a typo doesn't quietly slip a new value in.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'script_proof_characters_proof_type_check'
  ) THEN
    ALTER TABLE public.script_proof_characters
      ADD CONSTRAINT script_proof_characters_proof_type_check
      CHECK (proof_type IN (
        'case_study', 'testimonial', 'statistic', 'authority',
        'demonstration', 'social_volume', 'comparison'
      ));
  END IF;
END $$;

COMMENT ON COLUMN public.script_proof_characters.proof_type IS
  'Eugene Schwartz proof-type bucket. case_study (default, named client + result), testimonial, statistic, authority, demonstration, social_volume, comparison. Generator rotates types so a batch uses varied proof shapes.';

NOTIFY pgrst, 'reload schema';
