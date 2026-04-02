-- Add missing columns that the app tries to write/read
ALTER TABLE marketing_tracker ADD COLUMN IF NOT EXISTS auto_bookings INTEGER DEFAULT 0;
ALTER TABLE marketing_tracker ADD COLUMN IF NOT EXISTS live_calls INTEGER DEFAULT 0;
ALTER TABLE marketing_tracker ADD COLUMN IF NOT EXISTS calls_on_calendar INTEGER DEFAULT 0;
ALTER TABLE marketing_tracker ADD COLUMN IF NOT EXISTS finance_offers INTEGER DEFAULT 0;
ALTER TABLE marketing_tracker ADD COLUMN IF NOT EXISTS finance_accepted INTEGER DEFAULT 0;

-- Backfill live_calls from net_live_calls where live_calls is 0 but net_live_calls has data
UPDATE marketing_tracker SET live_calls = net_live_calls WHERE (live_calls IS NULL OR live_calls = 0) AND net_live_calls > 0;
-- Backfill calls_on_calendar from qualified_bookings
UPDATE marketing_tracker SET calls_on_calendar = qualified_bookings WHERE (calls_on_calendar IS NULL OR calls_on_calendar = 0) AND qualified_bookings > 0;
