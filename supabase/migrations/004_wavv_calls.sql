-- WAVV dialer call data (populated via Zapier: WAVV "Call Completed" trigger)
-- Column names match WAVV Zapier fields exactly for zero-config mapping
CREATE TABLE IF NOT EXISTS wavv_calls (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- WAVV fields (match Zapier output directly)
  call_id TEXT UNIQUE,                    -- WAVV call ID (dedup key)
  contact_name TEXT,                      -- Who was called
  phone_number TEXT,                      -- Contact phone
  started_at TIMESTAMPTZ NOT NULL,        -- When the call started
  call_duration INTEGER DEFAULT 0,        -- Duration in seconds
  user_id TEXT,                           -- WAVV user/agent ID
  team_id TEXT,                           -- WAVV team ID

  -- Derived fields (computed by dashboard, not Zapier)
  setter_id UUID,                         -- FK to team_members if matched
  ghl_contact_id TEXT,                    -- GHL contact matched by phone

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_wavv_calls_started ON wavv_calls (started_at DESC);
CREATE INDEX idx_wavv_calls_user ON wavv_calls (user_id, started_at DESC);
CREATE INDEX idx_wavv_calls_phone ON wavv_calls (phone_number);
CREATE INDEX idx_wavv_calls_ghl ON wavv_calls (ghl_contact_id) WHERE ghl_contact_id IS NOT NULL;

-- RLS
ALTER TABLE wavv_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON wavv_calls FOR SELECT USING (true);
CREATE POLICY "Allow anon insert" ON wavv_calls FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update" ON wavv_calls FOR UPDATE USING (true);
