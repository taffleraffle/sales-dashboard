-- Add audit fields for payment matching
ALTER TABLE payments ADD COLUMN IF NOT EXISTS manually_matched BOOLEAN DEFAULT false;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS matched_by TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ;
