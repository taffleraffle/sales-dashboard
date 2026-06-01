-- Auto-generated case studies — sales artillery from milestone wins.
-- Triggered when a client crosses a celebration threshold (4x+ ROI, $50K+ month, page-1 wins, etc).
-- Output: markdown case study + structured data points + strategist approval gate.

create table if not exists case_studies (
  id              uuid primary key default gen_random_uuid(),
  agency_id       uuid references agencies(id) default default_rom_agency_id(),
  client_id       uuid references clients(id) on delete cascade,
  trigger_kind    text not null,
  trigger_payload jsonb default '{}'::jsonb,
  headline        text not null,
  subhead         text,
  hero_quote      text,
  body_md         text,
  data_points     jsonb default '[]'::jsonb,
  before_after    jsonb default '{}'::jsonb,
  pull_quotes     jsonb default '[]'::jsonb,
  status          text default 'draft' check (status in ('draft','awaiting_strategist','approved','published','archived')),
  approved_by     text,
  approved_at     timestamptz,
  published_url   text,
  internal_only   boolean default false,
  generated_at    timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists idx_cs_client on case_studies(client_id, generated_at desc);
create index if not exists idx_cs_status on case_studies(status);

alter table case_studies enable row level security;
drop policy if exists "auth read case_studies" on case_studies;
create policy "auth read case_studies" on case_studies for select to authenticated using (true);

notify pgrst, 'reload schema';
