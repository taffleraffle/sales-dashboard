-- Track every client tier change for audit + automation
create table if not exists client_tier_transitions (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  from_tier       text,
  to_tier         text not null,
  reason          text,
  triggered_by    text,
  side_effects    jsonb default '[]'::jsonb,
  transitioned_at timestamptz default now()
);

create index if not exists idx_ctt_client on client_tier_transitions(client_id, transitioned_at desc);

alter table client_tier_transitions enable row level security;
drop policy if exists "auth read ctt" on client_tier_transitions;
create policy "auth read ctt" on client_tier_transitions for select to authenticated using (true);

notify pgrst, 'reload schema';
