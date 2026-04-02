-- Configurable payment blacklist (replaces hardcoded BLACKLIST array)
CREATE TABLE IF NOT EXISTS payment_blacklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern TEXT NOT NULL,
  match_field TEXT DEFAULT 'email' CHECK (match_field IN ('description', 'email', 'name')),
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE payment_blacklist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "blacklist_read" ON payment_blacklist FOR SELECT USING (true);
CREATE POLICY "blacklist_write" ON payment_blacklist FOR ALL USING (true) WITH CHECK (true);

-- Seed with existing hardcoded values
INSERT INTO payment_blacklist (pattern, match_field) VALUES
  ('daniel@rankonmaps.io', 'email'),
  ('rankonmaps', 'name');
