-- Add revenue_tier column to ghl_appointments.
--
-- Background: the Marketing page needs to split strategy-calendar bookings
-- into qualified ($30k+ monthly revenue) vs DQ ($0-$30k). Calendar ID alone
-- can't do this — both qualified and DQ prospects sometimes land on the same
-- calendar (e.g., RestorationConnect Strategy Call gets direct bookings AND
-- form-DQ-routed bookings).
--
-- The form writes the prospect's monthly revenue to GHL contact custom field
-- `Tb6fklGYdWcgl9vUS2q9` (also mirrored in `eiTsafUsji5ZQHJpcGDk`). We cache
-- the revenue tier on each appointment row at sync time so the Marketing
-- page can classify without per-page contact lookups.
--
-- Values look like "$0-$30,000", "$30-$50,000", "$50k-$75k/m", "$75k-$100k/m",
-- "$100-250k/m", "$250,000/m+" — DQ rule is `revenue_tier LIKE '$0-%'`.

ALTER TABLE ghl_appointments
  ADD COLUMN IF NOT EXISTS revenue_tier text;

CREATE INDEX IF NOT EXISTS idx_ghl_appointments_revenue_tier
  ON ghl_appointments(revenue_tier);

NOTIFY pgrst, 'reload schema';
