-- Audit trail for manual actions on commission data
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,   -- 'payment', 'client', 'commission'
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,         -- 'match', 'unmatch', 'edit', 'delete', 'create'
  old_value JSONB,
  new_value JSONB,
  performed_by TEXT,            -- user email
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_read" ON audit_log FOR SELECT USING (true);
CREATE POLICY "audit_write" ON audit_log FOR INSERT WITH CHECK (true);
