-- pg_cron schedules for the elite ops stack
-- Requires pg_cron + pg_net extensions

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Drop existing schedules with these names to allow re-running
do $$
declare j record;
begin
  for j in select jobname from cron.job where jobname in (
    'rank-tracking-nightly',
    'gsc-ga4-daily',
    'evidence-reel-friday',
    'touchpoint-compliance-daily'
  ) loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

-- Inline the project + service role into the helper. pg_cron stores SQL
-- in cron.job which is restricted to the postgres role, so this is safe.
create or replace function trigger_edge_function(fn_name text, body jsonb default '{}'::jsonb)
returns bigint language sql security definer as $$
  select net.http_post(
    url := 'https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/' || fn_name,
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rdGJuYXZ2ZWhtZHFkbHBudXN1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDIzOTg2NCwiZXhwIjoyMDg5ODE1ODY0fQ.M_Hjd-boJw0GJhHLKMiUvpZv_PPJ4c5mrP462NasT4E',
      'Content-Type', 'application/json'
    ),
    body := body,
    timeout_milliseconds := 300000
  );
$$;

-- 1. Rank tracking — every night 03:00 UTC (10pm CST)
select cron.schedule(
  'rank-tracking-nightly',
  '0 3 * * *',
  $$ select trigger_edge_function('rank-tracking-cron', '{}'::jsonb); $$
);

-- 2. GSC + GA4 daily — 05:00 UTC (12am CST) so GSC's 2-day lag has settled
select cron.schedule(
  'gsc-ga4-daily',
  '0 5 * * *',
  $$ select trigger_edge_function('gsc-ga4-sync', '{"lookback_days": 2}'::jsonb); $$
);

-- 3. Evidence reel — Fridays 14:00 UTC = 09:00 America/Chicago (CDT)
select cron.schedule(
  'evidence-reel-friday',
  '0 14 * * 5',
  $$ select trigger_edge_function('evidence-reel-friday', '{}'::jsonb); $$
);

-- 4. Touchpoint compliance sweeper — daily 12:00 UTC
select cron.schedule(
  'touchpoint-compliance-daily',
  '0 12 * * *',
  $$ select trigger_edge_function('touchpoint-compliance', '{}'::jsonb); $$
);
