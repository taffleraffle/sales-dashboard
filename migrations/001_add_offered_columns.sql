-- Add offered and offered_finance columns to closer_calls
-- Add reschedules column to marketing_tracker
-- Run this in Supabase SQL Editor

ALTER TABLE closer_calls ADD COLUMN IF NOT EXISTS offered boolean DEFAULT false;
ALTER TABLE closer_calls ADD COLUMN IF NOT EXISTS offered_finance boolean DEFAULT false;
ALTER TABLE marketing_tracker ADD COLUMN IF NOT EXISTS reschedules integer DEFAULT 0;
