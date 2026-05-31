-- 122_drop_legacy_angle_type_check.sql
-- Drop the legacy script_angles_type_check constraint.
--
-- Migration 109 originally added a CHECK constraint named
-- script_angles_type_check restricting angle_type to {problem, desire,
-- legacy}. Migration 121 added a NEW constraint named
-- script_angles_angle_type_check with the expanded value set
-- {problem, circumstance, outcome, desire, legacy} — but left the
-- legacy constraint in place, so inserts of 'circumstance' or
-- 'outcome' still failed with "violates check constraint
-- script_angles_type_check".
--
-- This migration drops the legacy constraint. The 121 constraint
-- continues to enforce the expanded set.

ALTER TABLE public.script_angles
  DROP CONSTRAINT IF EXISTS script_angles_type_check;

NOTIFY pgrst, 'reload schema';
