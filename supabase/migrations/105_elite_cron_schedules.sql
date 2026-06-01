-- Elite cron schedules
-- Adds: AI visibility (weekly), GBP health (daily), citation NAP (every 14d),
--       roadmap refresh (monthly), competitor watchdog (weekly)

do $$
declare j record;
begin
  for j in select jobname from cron.job where jobname in (
    'ai-visibility-weekly',
    'gbp-health-daily',
    'citation-nap-biweekly',
    'roadmap-refresh-monthly',
    'competitor-watchdog-weekly'
  ) loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

-- AI visibility — every Monday 06:00 UTC
select cron.schedule(
  'ai-visibility-weekly',
  '0 6 * * 1',
  $$ select trigger_edge_function('ai-visibility-probe', '{}'::jsonb); $$
);

-- GBP health — daily 13:00 UTC (8am CST)
select cron.schedule(
  'gbp-health-daily',
  '0 13 * * *',
  $$ select trigger_edge_function('gbp-health-check', '{}'::jsonb); $$
);

-- Citation NAP — every 14 days at 07:00 UTC, kicked off on the 1st and 15th
select cron.schedule(
  'citation-nap-biweekly',
  '0 7 1,15 * *',
  $$ select trigger_edge_function('citation-nap-sync', '{}'::jsonb); $$
);

-- Roadmap refresh — first of month 08:00 UTC. Function skips if recent roadmap exists.
select cron.schedule(
  'roadmap-refresh-monthly',
  '0 8 1 * *',
  $$ select net.http_post(
       url := 'https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/roadmap-refresh-batch',
       headers := jsonb_build_object('Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rdGJuYXZ2ZWhtZHFkbHBudXN1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDIzOTg2NCwiZXhwIjoyMDg5ODE1ODY0fQ.M_Hjd-boJw0GJhHLKMiUvpZv_PPJ4c5mrP462NasT4E', 'Content-Type', 'application/json'),
       body := '{}'::jsonb,
       timeout_milliseconds := 300000
     ); $$
);

-- Competitor watchdog — Tuesdays 06:00 UTC
select cron.schedule(
  'competitor-watchdog-weekly',
  '0 6 * * 2',
  $$ select trigger_edge_function('competitor-watchdog', '{}'::jsonb); $$
);
