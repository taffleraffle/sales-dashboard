-- 154: allow the 'duplicate' action on booking_excluded.
-- The Marketing-page drilldown DUP button writes action='duplicate'
-- (MarketingPerformance.jsx RowActions.apply), and the read side renders a
-- 'dup' status pill + restore button for it. The original CHECK only allowed
-- ('dq','remove','spam'), so every DUP click silently failed with a
-- check-constraint violation. Widen the CHECK to include 'duplicate'.
-- Tile/qualified counting already excludes ANY booking_excluded row
-- (NOT EXISTS booking_excluded), so 'duplicate' rows drop from the qualified
-- numbers correctly without further change.

ALTER TABLE public.booking_excluded DROP CONSTRAINT IF EXISTS booking_excluded_action_check;
ALTER TABLE public.booking_excluded ADD CONSTRAINT booking_excluded_action_check
  CHECK (action = ANY (ARRAY['dq','remove','spam','duplicate']));

NOTIFY pgrst, 'reload schema';
