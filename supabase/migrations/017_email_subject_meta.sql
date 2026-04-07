-- Per-subject metadata: workflow assignment + monitor flag
CREATE TABLE IF NOT EXISTS email_subject_meta (
  subject TEXT PRIMARY KEY,           -- normalized subject (matches loadEmailStats output)
  workflow_id TEXT,                   -- references ghl_workflows.id (nullable)
  workflow_name TEXT,                 -- denormalized for display
  monitored BOOLEAN DEFAULT false,
  monitored_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subject_meta_workflow ON email_subject_meta(workflow_id);
CREATE INDEX IF NOT EXISTS idx_subject_meta_monitored ON email_subject_meta(monitored);

ALTER TABLE email_subject_meta ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON email_subject_meta FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
