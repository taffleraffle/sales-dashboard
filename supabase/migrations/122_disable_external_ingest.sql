-- ============================================================
-- 122_disable_external_ingest.sql
--
-- Quality policy change (Ben 2026-06-01): editor submissions must
-- come in via TUS direct upload only. Frame.io and Google Drive
-- both serve compressed proxy videos by default, so even though the
-- ingest-external-submission Edge Function never transcodes, the
-- bytes pulled from those proxies already have quality loss baked
-- in vs the editor's original cut.
--
-- This migration:
--   1. Drops the BEFORE-INSERT trigger that stamped ingest_status
--      ='pending' on submissions with external_url.
--   2. Drops the AFTER-INSERT trigger that fired the Edge Function
--      via pg_net.
--
-- Past submissions that have already been ingested are NOT touched
-- — their file_url stays, their comments stay, their existing
-- ingest_status stays. The frontend ExternalLinkSubmitter UI was
-- removed in the same commit so editors no longer have a way to
-- paste an external URL in the first place. These trigger drops
-- are belt-and-braces in case a future endpoint accidentally
-- writes an external_url submission.
--
-- The Edge Function itself (ingest-external-submission) is left
-- deployed — the retry RPC + the function still work, so any
-- admin manually setting ingest_status='pending' on an existing
-- row can still trigger a pull. We just don't auto-fire on insert.
-- ============================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_stamp_ingest_pending
  ON public.lib_task_submissions;
DROP TRIGGER IF EXISTS trg_fire_ingest_external_submission
  ON public.lib_task_submissions;

-- The trigger FUNCTIONS stay (stamp_ingest_pending,
-- fire_ingest_external_submission, detect_ingest_source) — they're
-- harmless without the triggers and easy to re-attach if the policy
-- ever reverses. Same for retry_external_ingest RPC.

NOTIFY pgrst, 'reload schema';

COMMIT;
