-- Add Speed to Lead working-hour columns to team_members
-- These define the window during which leads count toward a setter's individual STL
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS stl_start_hour smallint;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS stl_end_hour smallint;

-- Seed current schedules
UPDATE team_members SET stl_start_hour = 9, stl_end_hour = 19 WHERE lower(name) LIKE 'josh%';
UPDATE team_members SET stl_start_hour = 8, stl_end_hour = 17 WHERE lower(name) LIKE 'leandre%' OR lower(name) LIKE 'leondre%' OR lower(name) LIKE 'lee %';
