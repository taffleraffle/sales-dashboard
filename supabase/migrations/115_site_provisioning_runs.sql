-- track every site-provisioning run from transcript -> repo -> deploy
create table if not exists site_provisioning_runs (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid references clients(id) on delete cascade,
  status                text not null check (status in ('extracted','repo_created','deployed','failed')),
  fathom_recording_id   text,
  repo_name             text,
  repo_url              text,
  client_json           jsonb,
  services_json         jsonb,
  areas_json            jsonb,
  extraction_notes      text,
  error_message         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_spr_client on site_provisioning_runs(client_id, created_at desc);
create index if not exists idx_spr_status on site_provisioning_runs(status, created_at desc);

-- auto-bump updated_at
create or replace function bump_site_provisioning_runs_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_spr_updated on site_provisioning_runs;
create trigger trg_spr_updated
  before update on site_provisioning_runs
  for each row execute function bump_site_provisioning_runs_updated_at();

alter table site_provisioning_runs enable row level security;
drop policy if exists "auth read spr" on site_provisioning_runs;
create policy "auth read spr" on site_provisioning_runs for select to authenticated using (true);

notify pgrst, 'reload schema';
