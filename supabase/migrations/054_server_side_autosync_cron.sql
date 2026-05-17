-- ============================================================
-- SERVER-SIDE AUTO-SYNC SCHEDULES
-- Replaces the browser-only autoSync.js loop for jobs that already
-- exist as Edge Functions. Runs on pg_cron regardless of whether
-- anyone has the dashboard open.
--
-- Run this in the Supabase SQL Editor.
-- Requires: pg_cron + pg_net (enabled in migration 015).
-- ============================================================

-- Extensions are already enabled by migration 015_auto_sync_cron.sql.
-- These CREATE statements are idempotent in case 015 hasn't been run yet.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Drop the old daily-only schedules — we're tightening cadence on
-- everything so the dashboard reflects reality without a tab open.
SELECT cron.unschedule('daily-stripe-sync')   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-stripe-sync');
SELECT cron.unschedule('daily-fanbasis-sync') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-fanbasis-sync');

-- ── Stripe — every 2 hours ──
SELECT cron.schedule(
  'auto-stripe-sync',
  '0 */2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-stripe-payments?days=14&limit=100&resync=false',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ── Fanbasis — every 2 hours ──
SELECT cron.schedule(
  'auto-fanbasis-sync',
  '5 */2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-fanbasis-payments?days=14&limit=100',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ── Typeform — hourly ──
-- Pulls a 730-day window so historical responses stay reachable. Function
-- is idempotent (upsert on response_id) so re-running every hour is cheap.
SELECT cron.schedule(
  'auto-typeform-sync',
  '10 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-typeform',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"days": 730}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- ── GHL contacts — every 2 hours ──
-- Full contact + attribution refresh. Heavy, hence the slower cadence.
SELECT cron.schedule(
  'auto-ghl-contacts-sync',
  '15 */2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-ghl-contacts',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"days": 730}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

-- ── HYROS retroactive — every 6 hours ──
-- Wide-window HYROS pull; pagination is heavy so we run it less often.
SELECT cron.schedule(
  'auto-hyros-sync',
  '20 */6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/hyros-sync',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"days": 365}'::jsonb,
    timeout_milliseconds := 600000
  );
  $$
);

-- ── Meta ad status — every 15 minutes ──
-- Lightweight: pulls effective_status for every ad on the account
-- (no insights, no creative payload). Keeps the "X/Y ACTIVE" badge
-- on /sales/ads/performance fresh without a tab open. The
-- sync-meta-ad-status Edge Function must be deployed first.
SELECT cron.schedule(
  'auto-meta-ad-status',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-meta-ad-status',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Verify:
--   SELECT jobname, schedule, command FROM cron.job ORDER BY jobname;
-- Inspect run history:
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
