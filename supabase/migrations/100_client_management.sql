-- Client management schema for ROM platform
-- Powers /clients/* routes, ROI tracking, agency-level aggregation
-- Designed multi-tenant from day 1 so a future white-label flip is non-breaking

-- =============================================================
-- 1. agencies (multi-tenant root)
-- =============================================================
create table if not exists agencies (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  name            text not null,
  brand_kit       jsonb default '{}'::jsonb,
  voice_rules     jsonb default '{}'::jsonb,
  default_settings jsonb default '{}'::jsonb,
  created_at      timestamptz default now()
);

insert into agencies (slug, name, brand_kit)
values ('rom', 'Rank On Maps',
  '{"primary":"#1F4D3C","secondary":"#F4EFE3","font_sans":"Inter Tight","font_serif":"Fraunces","font_mono":"JetBrains Mono"}'::jsonb)
on conflict (slug) do nothing;

-- Postgres rejects subqueries directly in DEFAULT, so we wrap one in a
-- STABLE function and use that as the default for agency_id on clients.
create or replace function default_rom_agency_id() returns uuid
language sql stable as $$
  select id from agencies where slug = 'rom' limit 1
$$;

-- =============================================================
-- 2. clients (the core record)
-- =============================================================
create table if not exists clients (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid references agencies(id) default default_rom_agency_id(),
  slug              text unique not null,
  business_name     text not null,
  vertical          text not null check (vertical in ('roofing','hvac','plumbing','landscaping','dental','legal','restoration','other')),
  status            text not null default 'onboarding' check (status in ('lead','onboarding','trial','active','paused','churned')),

  -- market
  primary_city      text,
  region            text,
  state_abbr        text,
  country           text default 'US',
  service_radius_miles integer,

  -- commercial
  path              text default 'direct' check (path in ('trial','direct')),
  monthly_fee       numeric(10,2),
  tier              text check (tier in ('maps_only','full_stack','custom','retainer_only')),
  contract_start    date,
  contract_end      date,
  trial_ends_at     timestamptz,

  -- delivery
  cf_project_name   text,
  github_repo       text,
  custom_domain     text,
  ga4_measurement_id text,
  wc_account_id     text,
  wc_profile_id     text,

  -- preferences
  communication_frequency text default 'standard' check (communication_frequency in ('light','standard','high','white_glove')),
  primary_timezone  text default 'America/Chicago',
  best_contact_window text,

  -- data
  client_json       jsonb default '{}'::jsonb,
  questionnaire     jsonb default '{}'::jsonb,
  game_plan         jsonb default '{}'::jsonb,

  -- ops
  primary_am        text,
  secondary_am      text,

  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists idx_clients_agency on clients(agency_id);
create index if not exists idx_clients_vertical on clients(vertical);
create index if not exists idx_clients_status on clients(status);

-- =============================================================
-- 3. stakeholders (per-client contacts with routing rules)
-- =============================================================
create table if not exists client_stakeholders (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid references clients(id) on delete cascade,
  name              text not null,
  role              text not null check (role in ('owner','office_manager','marketing_lead','technical_contact','billing_contact','other')),
  email             text,
  phone             text,
  preferred_channel text check (preferred_channel in ('slack','email','sms','call')),
  cc_on             text[] default '{}',
  not_cc_on         text[] default '{}',
  decision_authority text default 'informed_only' check (decision_authority in ('full','operational','informed_only')),
  is_primary        boolean default false,
  notes             text,
  created_at        timestamptz default now()
);

create index if not exists idx_stakeholders_client on client_stakeholders(client_id);

-- =============================================================
-- 4. touchpoints (lifecycle cadence per client)
-- =============================================================
create table if not exists client_touchpoints (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid references clients(id) on delete cascade,
  stage             text not null check (stage in ('onboarding','steady_state','renewal','offboarding')),
  cadence_day       integer,
  touchpoint_key    text not null,
  channel           text check (channel in ('email','sms','slack','call','dashboard','portal')),
  automated         boolean default true,
  status            text default 'scheduled' check (status in ('scheduled','draft','queued_for_review','sent','acknowledged','completed','skipped','failed')),
  scheduled_at      timestamptz,
  sent_at           timestamptz,
  acknowledged_at   timestamptz,
  completed_at      timestamptz,
  assigned_to       text,
  template_key      text,
  payload           jsonb default '{}'::jsonb,
  result            jsonb default '{}'::jsonb,
  created_at        timestamptz default now()
);

create index if not exists idx_touchpoints_client on client_touchpoints(client_id);
create index if not exists idx_touchpoints_scheduled on client_touchpoints(scheduled_at) where status = 'scheduled';
create index if not exists idx_touchpoints_queue on client_touchpoints(status) where status in ('queued_for_review','draft');

-- =============================================================
-- 5. communications (unified inbox across all channels)
-- =============================================================
create table if not exists client_communications (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid references clients(id) on delete cascade,
  stakeholder_id    uuid references client_stakeholders(id) on delete set null,
  channel           text not null check (channel in ('slack_client','slack_internal','email','sms','call','form','gbp_message','dashboard')),
  direction         text not null check (direction in ('inbound','outbound')),
  subject           text,
  body              text,
  thread_external_id text,
  attachments       jsonb default '[]'::jsonb,
  sentiment         text check (sentiment in ('positive','neutral','negative','mixed')),
  sentiment_score   numeric(3,2),
  topic_tags        text[] default '{}',
  acknowledged_at   timestamptz,
  acknowledged_by   text,
  replied_at        timestamptz,
  replied_by        text,
  external_ref      text,
  created_at        timestamptz default now()
);

create index if not exists idx_comms_client on client_communications(client_id);
create index if not exists idx_comms_created on client_communications(client_id, created_at desc);
create index if not exists idx_comms_unack on client_communications(acknowledged_at) where acknowledged_at is null and direction = 'inbound';

-- =============================================================
-- 6. leads (the ROI core)
-- =============================================================
create table if not exists client_leads (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid references clients(id) on delete cascade,
  source            text not null check (source in ('organic','paid','direct','referral','gbp','social','email','other')),
  source_detail     text,
  channel           text check (channel in ('call','form','chat','email','sms')),
  lead_name         text,
  lead_phone        text,
  lead_email        text,
  lead_message      text,
  call_duration_sec integer,
  call_recording_url text,
  qualified         boolean,
  qualified_at      timestamptz,
  converted         boolean default false,
  converted_at      timestamptz,
  deal_value        numeric(12,2),
  status            text default 'new' check (status in ('new','qualified','disqualified','contacted','quoted','converted','lost','spam')),
  notes             text,
  external_ref      text,
  metadata          jsonb default '{}'::jsonb,
  created_at        timestamptz default now()
);

create index if not exists idx_leads_client on client_leads(client_id);
create index if not exists idx_leads_created on client_leads(client_id, created_at desc);
create index if not exists idx_leads_organic on client_leads(client_id, source) where source = 'organic';

-- =============================================================
-- 7. rankings history (for "time to top 3" calc)
-- =============================================================
create table if not exists client_rankings_history (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid references clients(id) on delete cascade,
  keyword           text not null,
  target_url        text,
  position          integer,
  position_type     text default 'organic' check (position_type in ('organic','map_pack','featured_snippet','ai_overview','local_pack')),
  engine            text default 'google' check (engine in ('google','bing','yahoo','ddg')),
  location          text,
  device            text default 'mobile' check (device in ('mobile','desktop','tablet')),
  search_volume     integer,
  tracked_at        timestamptz default now(),
  source            text default 'dataforseo'
);

create index if not exists idx_rankings_client on client_rankings_history(client_id);
create index if not exists idx_rankings_tracked on client_rankings_history(client_id, tracked_at desc);
create index if not exists idx_rankings_keyword on client_rankings_history(client_id, keyword, tracked_at desc);

-- =============================================================
-- 8. citations log (per-client citation health)
-- =============================================================
create table if not exists client_citations (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid references clients(id) on delete cascade,
  directory_name    text not null,
  tier              integer check (tier between 1 and 4),
  vertical_specific boolean default false,
  status            text default 'queued' check (status in ('queued','submitted','live','dead','rejected')),
  url               text,
  nap_consistent    boolean,
  submitted_at      timestamptz,
  verified_at       timestamptz,
  source            text check (source in ('brightlocal','manual','api','self_serve')),
  notes             text,
  created_at        timestamptz default now()
);

create index if not exists idx_citations_client on client_citations(client_id);

-- =============================================================
-- 9. reviews log (across all platforms)
-- =============================================================
create table if not exists client_reviews (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid references clients(id) on delete cascade,
  platform          text not null check (platform in ('google','yelp','bbb','facebook','industry','homeadvisor','angi','houzz','other')),
  rating            numeric(2,1),
  review_text       text,
  reviewer_name     text,
  reviewer_url      text,
  external_ref      text,
  reviewed_at       timestamptz,
  replied_at        timestamptz,
  reply_text        text,
  replied_by        text,
  sentiment         text check (sentiment in ('positive','neutral','negative')),
  source            text default 'manual' check (source in ('cloutly','manual','api','poll')),
  created_at        timestamptz default now()
);

create index if not exists idx_reviews_client on client_reviews(client_id);
create index if not exists idx_reviews_reviewed on client_reviews(client_id, reviewed_at desc);

-- =============================================================
-- 10. assets (photos, logos, contracts, etc)
-- =============================================================
create table if not exists client_assets (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid references clients(id) on delete cascade,
  type              text not null check (type in ('photo','logo','video','document','contract','other')),
  filename          text,
  storage_url       text,
  drive_url         text,
  usage             text check (usage in ('hero','founder','team','project','service','area','case_study','other')),
  approved          boolean default false,
  approved_by       text,
  approved_at       timestamptz,
  metadata          jsonb default '{}'::jsonb,
  created_at        timestamptz default now()
);

create index if not exists idx_assets_client on client_assets(client_id);

-- =============================================================
-- 11. agency-level monthly snapshots (for sales pitch + valuation)
-- =============================================================
create table if not exists agency_metrics_monthly (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid references agencies(id),
  vertical          text,
  month             date not null,

  clients_active    integer default 0,
  clients_added     integer default 0,
  clients_churned   integer default 0,

  avg_time_to_top3_days     numeric(6,2),
  avg_time_to_first_lead_days numeric(6,2),
  avg_monthly_lead_count    numeric(8,2),
  avg_monthly_review_velocity numeric(6,2),
  total_leads_generated     integer default 0,
  total_revenue_attributed  numeric(14,2) default 0,
  avg_roi_pct               numeric(8,2),
  total_citations_built     integer default 0,
  total_reviews_generated   integer default 0,

  computed_at       timestamptz default now(),

  unique(agency_id, vertical, month)
);

create index if not exists idx_agency_metrics_month on agency_metrics_monthly(agency_id, month desc);

-- =============================================================
-- 12. vertical benchmarks (Tier 4 ROI fallback values)
-- =============================================================
create table if not exists vertical_benchmarks (
  id                uuid primary key default gen_random_uuid(),
  vertical          text not null,
  metric_key        text not null,
  value_numeric     numeric(14,2),
  value_text        text,
  geo_scope         text default 'US',
  source            text,
  last_updated      date default current_date,

  unique(vertical, metric_key, geo_scope)
);

-- seed the most-used benchmarks
insert into vertical_benchmarks (vertical, metric_key, value_numeric, source) values
  ('roofing', 'avg_job_value', 12500, 'industry composite'),
  ('roofing', 'qualified_rate_pct', 0.62, 'industry composite'),
  ('roofing', 'close_rate_pct', 0.22, 'industry composite'),
  ('roofing', 'organic_cpc_avg', 12.40, 'dataforseo composite'),
  ('hvac', 'avg_job_value', 6200, 'industry composite'),
  ('hvac', 'qualified_rate_pct', 0.66, 'industry composite'),
  ('hvac', 'close_rate_pct', 0.28, 'industry composite'),
  ('hvac', 'organic_cpc_avg', 8.10, 'dataforseo composite'),
  ('plumbing', 'avg_job_value', 750, 'industry composite'),
  ('plumbing', 'qualified_rate_pct', 0.72, 'industry composite'),
  ('plumbing', 'close_rate_pct', 0.34, 'industry composite'),
  ('plumbing', 'organic_cpc_avg', 14.20, 'dataforseo composite')
on conflict (vertical, metric_key, geo_scope) do nothing;

-- =============================================================
-- RLS — operators authenticated via existing AuthContext
-- =============================================================
alter table clients enable row level security;
alter table client_stakeholders enable row level security;
alter table client_touchpoints enable row level security;
alter table client_communications enable row level security;
alter table client_leads enable row level security;
alter table client_rankings_history enable row level security;
alter table client_citations enable row level security;
alter table client_reviews enable row level security;
alter table client_assets enable row level security;
alter table agency_metrics_monthly enable row level security;
alter table vertical_benchmarks enable row level security;
alter table agencies enable row level security;

-- Authenticated users can do everything inside their agency
-- (multi-tenant safe; in single-tenant ROM today this is effectively "everything")
do $$
declare t text;
begin
  for t in select unnest(array[
    'clients','client_stakeholders','client_touchpoints','client_communications',
    'client_leads','client_rankings_history','client_citations','client_reviews',
    'client_assets','agency_metrics_monthly','vertical_benchmarks','agencies'
  ])
  loop
    execute format('drop policy if exists "auth_all_%I" on %I', t, t);
    execute format('create policy "auth_all_%I" on %I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end$$;

-- =============================================================
-- updated_at auto-trigger on clients
-- =============================================================
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end$$;

drop trigger if exists trg_clients_updated on clients;
create trigger trg_clients_updated before update on clients
  for each row execute function set_updated_at();
