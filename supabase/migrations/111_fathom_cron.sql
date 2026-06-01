-- Cron schedule for fathom-handoff-watcher: every 30 minutes
-- Polls Fathom for new recordings + auto-fires handoff-brief for client-matched calls

do $$
begin
  if exists (select 1 from cron.job where jobname = 'fathom-handoff-watcher') then
    perform cron.unschedule('fathom-handoff-watcher');
  end if;
end $$;

select cron.schedule(
  'fathom-handoff-watcher',
  '*/30 * * * *',
  $$ select trigger_edge_function('fathom-handoff-watcher', '{"hours_back": 6}'::jsonb); $$
);
