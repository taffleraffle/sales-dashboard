-- ============================================================
-- AUTO-SYNC CRON JOBS
-- Run this in the Supabase SQL Editor (not via migration CLI)
-- Requires: pg_cron + pg_net extensions (available on all Supabase projects)
-- ============================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Daily Stripe Payment Sync ──
-- Runs at 6am ET (11am UTC during EDT, 10am during EST)
-- Pulls last 7 days of Stripe charges and syncs to payments table
SELECT cron.schedule(
  'daily-stripe-sync',
  '0 11 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-stripe-payments?days=7&limit=100&resync=true',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ── Daily Fanbasis Payment Sync ──
-- Runs at 6:15am ET (11:15am UTC during EDT)
-- Will activate once FANBASIS_API_KEY is configured in Supabase secrets
SELECT cron.schedule(
  'daily-fanbasis-sync',
  '15 11 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/sync-fanbasis-payments?days=7&limit=100',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Verify jobs are scheduled
-- SELECT * FROM cron.job;
