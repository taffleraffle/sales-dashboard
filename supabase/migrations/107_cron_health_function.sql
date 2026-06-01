-- Companion migration for cron-health-monitor edge function.
-- Exposes cron schema data (which is not PostgREST-accessible by default) via a SECURITY DEFINER function.

create or replace function public.get_cron_health_24h()
returns table (
  jobname text,
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
)
language sql security definer set search_path = cron, public as $$
  select
    j.jobname::text,
    jr.status::text,
    coalesce(jr.return_message, '')::text as return_message,
    jr.start_time,
    jr.end_time
  from cron.job_run_details jr
  join cron.job j on j.jobid = jr.jobid
  where jr.start_time > now() - interval '24 hours'
  order by jr.start_time desc;
$$;

grant execute on function public.get_cron_health_24h() to service_role;

notify pgrst, 'reload schema';
