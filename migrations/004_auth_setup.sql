-- Add auth_user_id column to team_members to link Supabase Auth users to team members
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE;

-- Create user_profiles table for admin/manager accounts not tied to a team member
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID UNIQUE NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'viewer', -- 'admin', 'manager', 'viewer'
  team_member_id UUID REFERENCES team_members(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for fast auth lookups
CREATE INDEX IF NOT EXISTS idx_team_members_auth_user_id ON team_members(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_auth_user_id ON user_profiles(auth_user_id);
