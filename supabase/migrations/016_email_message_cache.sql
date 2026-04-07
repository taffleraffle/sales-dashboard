-- Email message cache for GHL workflow email analytics
CREATE TABLE IF NOT EXISTS email_message_cache (
  id TEXT PRIMARY KEY,                -- inner email message id from GHL
  conversation_id TEXT,
  contact_id TEXT,
  subject TEXT,
  status TEXT,                        -- delivered, opened, clicked, failed, sent
  source TEXT,                        -- workflow, manual, etc.
  direction TEXT,                     -- inbound, outbound
  date_added TIMESTAMPTZ,
  date_updated TIMESTAMPTZ,
  provider TEXT,
  synced_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_cache_subject ON email_message_cache(subject);
CREATE INDEX IF NOT EXISTS idx_email_cache_status ON email_message_cache(status);
CREATE INDEX IF NOT EXISTS idx_email_cache_date ON email_message_cache(date_added);
CREATE INDEX IF NOT EXISTS idx_email_cache_source ON email_message_cache(source);

-- GHL Workflow list cache
CREATE TABLE IF NOT EXISTS ghl_workflows (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT,
  synced_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE email_message_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ghl_workflows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all" ON email_message_cache FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON ghl_workflows FOR ALL USING (true) WITH CHECK (true);
