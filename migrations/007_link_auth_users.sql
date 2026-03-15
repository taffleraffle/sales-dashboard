-- 1. Add auth_user_id column to team_members
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE;

-- 2. Create user_profiles table for admin/manager accounts
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID UNIQUE NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'viewer',
  team_member_id UUID REFERENCES team_members(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_members_auth_user_id ON team_members(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_auth_user_id ON user_profiles(auth_user_id);

-- 3. RLS policies
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow authenticated read user_profiles" ON user_profiles
  FOR SELECT TO authenticated USING (true);

DO $$ BEGIN
  CREATE POLICY "Allow authenticated read team_members_auth" ON team_members
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. Link auth users to team_members
UPDATE team_members SET auth_user_id = '13d5e43b-78e2-4f2f-9493-f85c4526ca9e'
WHERE name = 'Daniel' AND role = 'closer';

UPDATE team_members SET auth_user_id = 'abb76743-ef3e-4e63-b53e-8bc14e522ea5'
WHERE name = 'Josh' AND role = 'setter';

UPDATE team_members SET auth_user_id = '89ff94a8-c78b-49bf-8713-40d5671b56d9'
WHERE name = 'Leandre' AND role = 'setter';

-- 5. Create Ben's admin profile
INSERT INTO user_profiles (auth_user_id, display_name, role)
VALUES ('a7c1a5a8-b988-4902-8e49-03cbd433c838', 'Ben', 'admin')
ON CONFLICT (auth_user_id) DO UPDATE SET role = 'admin', display_name = 'Ben';
