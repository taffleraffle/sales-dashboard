-- Track which Fathom recordings have been processed by handoff-brief generator
-- so the auto-poller doesn't re-process the same call every 30 minutes.

create table if not exists processed_fathom_recordings (
  recording_id    text primary key,
  fathom_url      text,
  brief_id        uuid references handoff_briefs(id) on delete set null,
  client_id       uuid references clients(id) on delete set null,
  meeting_title   text,
  call_date       timestamptz,
  invitees        jsonb default '[]'::jsonb,
  attached_client boolean default false,
  status          text default 'processed' check (status in ('processed','skipped','errored','attached')),
  reason_skipped  text,
  processed_at    timestamptz default now()
);

create index if not exists idx_pfr_call_date on processed_fathom_recordings(call_date desc);
create index if not exists idx_pfr_status on processed_fathom_recordings(status);

alter table processed_fathom_recordings enable row level security;
drop policy if exists "auth read pfr" on processed_fathom_recordings;
create policy "auth read pfr" on processed_fathom_recordings for select to authenticated using (true);

notify pgrst, 'reload schema';
