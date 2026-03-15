-- Add wavv_user_id to team_members for WAVV dialer integration
-- This links team members to their WAVV user accounts for auto-fill in EOD reports
-- Run this in Supabase SQL Editor

ALTER TABLE team_members ADD COLUMN IF NOT EXISTS wavv_user_id VARCHAR(100);

-- After running this migration, populate wavv_user_id for each setter:
-- UPDATE team_members SET wavv_user_id = '<wavv-user-id>' WHERE name = 'Josh';
-- UPDATE team_members SET wavv_user_id = '<wavv-user-id>' WHERE name = 'Leondre';
--
-- To find WAVV user IDs, run:
-- SELECT DISTINCT user_id FROM wavv_calls ORDER BY user_id;
