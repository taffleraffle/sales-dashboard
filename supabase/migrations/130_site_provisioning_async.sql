-- expand status check to support async/background processing
alter table site_provisioning_runs
  drop constraint if exists site_provisioning_runs_status_check;

alter table site_provisioning_runs
  add constraint site_provisioning_runs_status_check
  check (status in ('pending','extracting','extracted','repo_created','deployed','failed'));

-- add async tracking columns (idempotent)
alter table site_provisioning_runs add column if not exists request_payload jsonb;
alter table site_provisioning_runs add column if not exists webhook_url text;

notify pgrst, 'reload schema';
