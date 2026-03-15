-- GHL appointments cache table
-- Synced from GHL API to avoid slow N+1 contact lookups on every page load
CREATE TABLE IF NOT EXISTS ghl_appointments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ghl_event_id text UNIQUE NOT NULL,
  closer_id uuid REFERENCES team_members(id),
  ghl_user_id text,
  contact_name text NOT NULL,
  contact_email text DEFAULT '',
  contact_phone text DEFAULT '',
  start_time text, -- GHL local time string e.g. "2026-03-13 13:00:00"
  end_time text,
  calendar_name text DEFAULT '',
  appointment_status text DEFAULT 'confirmed',
  appointment_date date NOT NULL,
  ghl_contact_id text DEFAULT '',
  outcome text, -- no_show, showed, not_closed, closed (set during EOD)
  revenue numeric DEFAULT 0,
  cash_collected numeric DEFAULT 0,
  notes text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Index for fast lookup by closer + date
CREATE INDEX IF NOT EXISTS idx_ghl_appointments_closer_date
  ON ghl_appointments(closer_id, appointment_date);

-- RLS: open access (same as other tables)
ALTER TABLE ghl_appointments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to ghl_appointments"
  ON ghl_appointments FOR ALL
  USING (true) WITH CHECK (true);

-- Update Daniel's GHL user ID
UPDATE team_members
SET ghl_user_id = 'MhZNmEy4wcv7DyL5PFs2'
WHERE name = 'Daniel' AND role = 'closer';
