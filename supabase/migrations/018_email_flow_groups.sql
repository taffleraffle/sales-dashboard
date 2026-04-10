-- Custom email flow groups — user-defined groupings of email subjects
CREATE TABLE IF NOT EXISTS email_flow_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  color TEXT DEFAULT '#f0e050',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE email_flow_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON email_flow_groups FOR ALL USING (true) WITH CHECK (true);

-- Add flow_group_id to email_subject_meta
ALTER TABLE email_subject_meta ADD COLUMN IF NOT EXISTS flow_group_id UUID REFERENCES email_flow_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_subject_meta_flow_group ON email_subject_meta(flow_group_id);

NOTIFY pgrst, 'reload schema';
