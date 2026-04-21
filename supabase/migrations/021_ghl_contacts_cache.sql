-- Cache GHL contact names to avoid rate limit issues showing IDs instead of names
CREATE TABLE IF NOT EXISTS ghl_contacts_cache (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ghl_contacts_cache ENABLE ROW LEVEL SECURITY;

GRANT ALL ON ghl_contacts_cache TO authenticated, service_role;

CREATE POLICY "read_write_auth" ON ghl_contacts_cache
  FOR ALL USING (auth.role() IN ('authenticated', 'service_role'));

NOTIFY pgrst, 'reload schema';
