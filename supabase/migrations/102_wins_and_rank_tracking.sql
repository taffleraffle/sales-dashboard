-- Wins + rank tracking + win-trigger primitives
-- Powers #client-wins Slack channel, HQ Wins tab, rank delta detection

-- =============================================================
-- 1. wins (the live ledger)
-- =============================================================
create table if not exists wins (
  id              uuid primary key default gen_random_uuid(),
  agency_id       uuid references agencies(id) default default_rom_agency_id(),
  client_id       uuid references clients(id) on delete cascade,
  kind            text not null check (kind in (
    'new_lead',
    'rank_jump',
    'new_review_5star',
    'content_indexed',
    'milestone',
    'new_client_signed',
    'gbp_post_traction',
    'citation_built',
    'backlink_earned',
    'serp_feature_won'
  )),
  headline        text not null,
  detail          text,
  payload         jsonb default '{}'::jsonb,
  source          text,
  slack_channel_id text,
  slack_message_ts text,
  slack_posted_at  timestamptz,
  created_at      timestamptz default now()
);

create index if not exists idx_wins_client_created on wins(client_id, created_at desc);
create index if not exists idx_wins_kind_created on wins(kind, created_at desc);
create index if not exists idx_wins_agency_created on wins(agency_id, created_at desc);

-- =============================================================
-- 2. tracked_keywords (rank universe per client)
-- =============================================================
create table if not exists tracked_keywords (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  keyword         text not null,
  search_location text,
  search_engine   text default 'google',
  device          text default 'desktop' check (device in ('desktop','mobile')),
  is_money_keyword boolean default false,
  is_geo_modifier  boolean default false,
  added_at        timestamptz default now(),
  unique(client_id, keyword, search_location, device)
);

create index if not exists idx_tracked_kw_client on tracked_keywords(client_id);

-- =============================================================
-- 3. rank_history (nightly snapshots)
-- =============================================================
create table if not exists rank_history (
  id              uuid primary key default gen_random_uuid(),
  tracked_kw_id   uuid references tracked_keywords(id) on delete cascade,
  client_id       uuid references clients(id) on delete cascade,
  position        integer,
  url             text,
  serp_features   jsonb default '[]'::jsonb,
  checked_at      timestamptz default now(),
  delta_vs_yesterday integer
);

create index if not exists idx_rank_hist_kw_time on rank_history(tracked_kw_id, checked_at desc);
create index if not exists idx_rank_hist_client_time on rank_history(client_id, checked_at desc);

-- =============================================================
-- 4. gsc_metrics_daily (clicks/impressions per client per day)
-- =============================================================
create table if not exists gsc_metrics_daily (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  date            date not null,
  clicks          integer default 0,
  impressions     integer default 0,
  ctr             numeric(6,4),
  avg_position    numeric(6,2),
  top_queries     jsonb default '[]'::jsonb,
  top_pages       jsonb default '[]'::jsonb,
  fetched_at      timestamptz default now(),
  unique(client_id, date)
);

create index if not exists idx_gsc_client_date on gsc_metrics_daily(client_id, date desc);

-- =============================================================
-- 5. ga4_metrics_daily (sessions/conversions per client per day)
-- =============================================================
create table if not exists ga4_metrics_daily (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  date            date not null,
  sessions        integer default 0,
  users           integer default 0,
  engaged_sessions integer default 0,
  conversions     integer default 0,
  organic_sessions integer default 0,
  organic_conversions integer default 0,
  top_channels    jsonb default '[]'::jsonb,
  fetched_at      timestamptz default now(),
  unique(client_id, date)
);

create index if not exists idx_ga4_client_date on ga4_metrics_daily(client_id, date desc);

-- =============================================================
-- 6. handoff_briefs (closer call → AM brief)
-- =============================================================
create table if not exists handoff_briefs (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  fathom_recording_id text,
  fathom_url      text,
  closer_name     text,
  call_date       timestamptz,
  promises_made   jsonb default '[]'::jsonb,
  icp_confirmed   jsonb default '{}'::jsonb,
  scope_locked    jsonb default '{}'::jsonb,
  red_flags       jsonb default '[]'::jsonb,
  upsell_seeds    jsonb default '[]'::jsonb,
  summary         text,
  raw_transcript  text,
  status          text default 'draft' check (status in ('draft','reviewed','approved','outdated')),
  created_at      timestamptz default now()
);

create index if not exists idx_handoff_client on handoff_briefs(client_id, created_at desc);

-- =============================================================
-- 7. qa_reviews (adversarial QA agent outputs)
-- =============================================================
create table if not exists qa_reviews (
  id              uuid primary key default gen_random_uuid(),
  artifact_type   text not null,
  artifact_id     uuid,
  client_id       uuid references clients(id) on delete set null,
  verdict         text check (verdict in ('approve','reject','revise')),
  score           integer check (score between 0 and 100),
  critique        text,
  required_fixes  jsonb default '[]'::jsonb,
  reviewed_at     timestamptz default now()
);

create index if not exists idx_qa_artifact on qa_reviews(artifact_type, artifact_id);

-- =============================================================
-- 8. evidence_reel_log (weekly auto-post receipts)
-- =============================================================
create table if not exists evidence_reel_log (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  week_starting   date not null,
  body            text,
  slack_channel_id text,
  slack_message_ts text,
  posted_at       timestamptz default now(),
  unique(client_id, week_starting)
);

-- =============================================================
-- 9. touchpoint_compliance_log
-- =============================================================
create table if not exists touchpoint_compliance_log (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  touchpoint_key  text not null,
  scheduled_for   date not null,
  status          text check (status in ('met','missed','snoozed','na')),
  evidence_url    text,
  swept_at        timestamptz default now()
);

create index if not exists idx_compliance_client on touchpoint_compliance_log(client_id, scheduled_for desc);

-- =============================================================
-- 10. RLS posture (open by default — service role only, anon read for HQ tiles)
-- =============================================================
alter table wins enable row level security;
alter table tracked_keywords enable row level security;
alter table rank_history enable row level security;
alter table gsc_metrics_daily enable row level security;
alter table ga4_metrics_daily enable row level security;
alter table handoff_briefs enable row level security;
alter table qa_reviews enable row level security;
alter table evidence_reel_log enable row level security;
alter table touchpoint_compliance_log enable row level security;

drop policy if exists "authenticated read wins" on wins;
create policy "authenticated read wins" on wins for select to authenticated using (true);

drop policy if exists "authenticated read tracked_keywords" on tracked_keywords;
create policy "authenticated read tracked_keywords" on tracked_keywords for select to authenticated using (true);

drop policy if exists "authenticated read rank_history" on rank_history;
create policy "authenticated read rank_history" on rank_history for select to authenticated using (true);

drop policy if exists "authenticated read gsc" on gsc_metrics_daily;
create policy "authenticated read gsc" on gsc_metrics_daily for select to authenticated using (true);

drop policy if exists "authenticated read ga4" on ga4_metrics_daily;
create policy "authenticated read ga4" on ga4_metrics_daily for select to authenticated using (true);

drop policy if exists "authenticated read handoff" on handoff_briefs;
create policy "authenticated read handoff" on handoff_briefs for select to authenticated using (true);

drop policy if exists "authenticated read qa" on qa_reviews;
create policy "authenticated read qa" on qa_reviews for select to authenticated using (true);

drop policy if exists "authenticated read reel" on evidence_reel_log;
create policy "authenticated read reel" on evidence_reel_log for select to authenticated using (true);

drop policy if exists "authenticated read compliance" on touchpoint_compliance_log;
create policy "authenticated read compliance" on touchpoint_compliance_log for select to authenticated using (true);

-- =============================================================
-- 11. Helper view — wins last 7 days grouped by client
-- =============================================================
create or replace view wins_last_7d_per_client as
select
  c.id as client_id,
  c.business_name,
  c.slug,
  count(w.id) as wins_7d,
  count(*) filter (where w.kind = 'new_lead') as leads_7d,
  count(*) filter (where w.kind = 'rank_jump') as rank_jumps_7d,
  count(*) filter (where w.kind = 'new_review_5star') as reviews_7d,
  count(*) filter (where w.kind = 'content_indexed') as content_indexed_7d,
  max(w.created_at) as last_win_at
from clients c
left join wins w on w.client_id = c.id and w.created_at >= now() - interval '7 days'
group by c.id, c.business_name, c.slug;

-- =============================================================
-- 12. Reload PostgREST schema cache
-- =============================================================
notify pgrst, 'reload schema';
