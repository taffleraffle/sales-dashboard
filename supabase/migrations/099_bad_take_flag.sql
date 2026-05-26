-- Flag raw takes that shouldn't be used (bad angle, wrong script, technical failure, etc.)
-- Hidden by default in library view. Unlike is_low_quality (storage issue), this is
-- a deliberate editorial judgement call by the coordinator.

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS is_bad_take     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bad_take_reason TEXT;

NOTIFY pgrst, 'reload schema';
