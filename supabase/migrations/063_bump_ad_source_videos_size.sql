-- 063_bump_ad_source_videos_size.sql
--
-- The ad-source-videos bucket was created with a default size limit
-- that rejects creative uploads >~17MB. Restoration ads filmed on phones
-- can hit 100-200MB. Bump the limit to 500MB.
--
-- IMPORTANT runtime constraint downstream: OpenAI Whisper API has a 25MB
-- per-file limit. Files >25MB will upload successfully but the
-- transcribe-uploaded-ad Edge Function will fail at the Whisper step.
-- The UI surfaces this constraint via a warning chip on >25MB files.
--
-- Future: extract audio server-side before sending to Whisper to bypass
-- the 25MB constraint on video files.

BEGIN;

UPDATE storage.buckets
SET file_size_limit = 524288000  -- 500MB
WHERE id = 'ad-source-videos';

NOTIFY pgrst, 'reload schema';

COMMIT;
