-- Add contacted column to setter_leads for tracking whether leads have been contacted
ALTER TABLE setter_leads ADD COLUMN IF NOT EXISTS contacted boolean DEFAULT false;
