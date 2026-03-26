-- Add source and tags columns for manual transcript entry
ALTER TABLE closer_transcripts ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'fathom';
ALTER TABLE closer_transcripts ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;

-- Indexes for Call Data page queries
CREATE INDEX IF NOT EXISTS idx_closer_transcripts_meeting_date ON closer_transcripts(meeting_date DESC);
CREATE INDEX IF NOT EXISTS idx_closer_transcripts_closer_id ON closer_transcripts(closer_id);
