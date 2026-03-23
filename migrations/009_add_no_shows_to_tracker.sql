-- Add no_shows column to marketing_tracker
-- Stores actual closer-reported no-shows (nc_no_shows + fu_no_shows from EOD)
-- instead of deriving from qualified_bookings - live_calls which mixes data sources
ALTER TABLE marketing_tracker ADD COLUMN IF NOT EXISTS no_shows INTEGER DEFAULT 0;
