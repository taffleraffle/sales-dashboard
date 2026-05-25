-- ============================================================
-- 098_notify_on_unassigned.sql
--
-- When a new raw clip lands in lib_creative_library without an
-- assigned editor (and isn't a Testimony), notify the assignment
-- coordinator so they can route it to an editor.
--
-- Two surfaces:
--   1. In-dashboard bell — a row in lib_editor_notifications
--      with kind='new_upload_needs_assignment' fires immediately
--      via a Postgres trigger.
--   2. Email digest — a pg_cron job hits the notify-admin-digest
--      Edge Function every 15 minutes, batches all unsent
--      notifications of this kind into a single email per editor,
--      and stamps email_sent_at on the included rows.
--
-- Coordinator selection — any editor with notify_on_unassigned=TRUE.
-- This migration auto-flags Kirill (matched by name) if present;
-- additional coordinators can be flagged by an UPDATE later.
-- ============================================================

BEGIN;

-- 1. notify_on_unassigned flag on the editors table.
ALTER TABLE public.lib_creative_editors
  ADD COLUMN IF NOT EXISTS notify_on_unassigned BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Best-effort: flag Kirill (the assignment coordinator). Match by
-- name — covers 'Kirill', 'Kirill Mamajevs', 'Kmamajevs'. No-op if no
-- such row exists; operator can flag manually via UPDATE later.
UPDATE public.lib_creative_editors
SET notify_on_unassigned = TRUE
WHERE active IS NOT FALSE
  AND (name ILIKE '%kirill%' OR name ILIKE '%kmamajevs%');

-- 3. Trigger function — produces one notification row per flagged
-- editor when a row enters (or newly transitions into) the raw +
-- unassigned + non-Testimony state.
--
-- Dedupe via the (creative_id, editor_id, kind) tuple so re-runs of
-- the trigger (or the UPDATE OF firing repeatedly) don't pile up
-- duplicate notifications for the same clip.
CREATE OR REPLACE FUNCTION public.notify_on_unassigned_creative()
RETURNS TRIGGER AS $$
DECLARE
  qualifies      BOOLEAN;
  was_qualifying BOOLEAN;
  rec            RECORD;
  display_name   TEXT;
  display_body   TEXT;
BEGIN
  qualifies := NEW.status = 'raw'
               AND NEW.assigned_editor_id IS NULL
               AND NEW.type IS DISTINCT FROM 'Testimony';
  IF NOT qualifies THEN
    RETURN NEW;
  END IF;

  -- On UPDATE, only fire when the row JUST became qualifying.
  -- Without this guard, every harmless UPDATE (e.g. has_been_run,
  -- description patch from describe Edge Function) would re-trigger
  -- and the dedupe SELECT below would do all the work — wasted I/O.
  IF TG_OP = 'UPDATE' THEN
    was_qualifying := OLD.status = 'raw'
                      AND OLD.assigned_editor_id IS NULL
                      AND OLD.type IS DISTINCT FROM 'Testimony';
    IF was_qualifying THEN
      RETURN NEW;
    END IF;
  END IF;

  display_name := COALESCE(NEW.canonical_name, NEW.name, NEW.id::text);
  -- At INSERT time description + creator are usually NULL (filled in
  -- later by describe / identify-actor). Fall back gracefully.
  display_body := COALESCE(
    NULLIF(TRIM(NEW.description), ''),
    'New ' || COALESCE(NEW.type, 'clip') || ' from ' || COALESCE(NEW.creator, 'unknown creator')
  );

  FOR rec IN
    SELECT id FROM public.lib_creative_editors
    WHERE notify_on_unassigned = TRUE
      AND active IS NOT FALSE
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.lib_editor_notifications
      WHERE creative_id = NEW.id
        AND editor_id = rec.id
        AND kind = 'new_upload_needs_assignment'
    ) THEN
      INSERT INTO public.lib_editor_notifications
        (editor_id, kind, creative_id, title, body, link_path)
      VALUES
        (rec.id,
         'new_upload_needs_assignment',
         NEW.id,
         'Needs editor: ' || display_name,
         display_body,
         '/sales/ads/creative/library?stage=raw_unused');
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_on_unassigned_creative
  ON public.lib_creative_library;

CREATE TRIGGER trg_notify_on_unassigned_creative
  AFTER INSERT OR UPDATE OF status, assigned_editor_id, type
  ON public.lib_creative_library
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_on_unassigned_creative();

-- 4. pg_cron schedule — every 15 minutes, fire the digest function.
-- Requires pg_cron + pg_net (already enabled by migrations 015 / 054).
-- The function is idempotent: if there are no pending notifications,
-- it returns quickly without sending mail.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('notify-admin-unassigned-digest')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notify-admin-unassigned-digest');

SELECT cron.schedule(
  'notify-admin-unassigned-digest',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/notify-admin-digest',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

NOTIFY pgrst, 'reload schema';

COMMIT;
