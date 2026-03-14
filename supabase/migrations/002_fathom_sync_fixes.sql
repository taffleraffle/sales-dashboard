-- Allow closer_transcripts without a matched closer (unmatched Fathom meetings)
ALTER TABLE closer_transcripts ALTER COLUMN closer_id DROP NOT NULL;

-- Add index for fast dedup lookups
CREATE INDEX IF NOT EXISTS idx_closer_transcripts_fathom_id ON closer_transcripts(fathom_meeting_id);
