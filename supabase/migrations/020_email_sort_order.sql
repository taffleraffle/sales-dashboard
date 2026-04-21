-- Add sort_order to email_subject_meta for ordering emails within a flow
ALTER TABLE email_subject_meta ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_email_subject_meta_sort_order ON email_subject_meta(sort_order);

NOTIFY pgrst, 'reload schema';
