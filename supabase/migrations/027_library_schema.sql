-- 027_library_schema.sql
-- Creative Library & Performance Tracker — schema migration
-- Based on the four-variable test structure: hook, body_angle, scene, creator
-- See OPT-MetaAd-Naming-SOP-v2-2026-05-09.docx for the naming grammar
-- Phase 1 of the build plan (foundation only — no kanban, no production_tasks)

create schema if not exists library;

-- ============================================================
-- 1. components: atomic test variables
-- ============================================================
-- Every component is one of: hook, body_angle, scene, creator
-- component_id is the canonical short code (e.g. "H4.2", "BA-PROOF", "S-OFFICE", "OSO")

create table library.components (
  id              uuid primary key default gen_random_uuid(),
  component_id    text unique not null,
  type            text not null check (type in ('hook', 'body_angle', 'scene', 'creator')),
  label           text not null,
  description     text,
  -- Type-specific optional fields
  script_text     text,                  -- for hooks and body_angles
  duration_sec    int,                   -- for hooks and body_angles
  asset_url       text,                  -- reference asset if any
  -- Lifecycle
  status          text not null default 'concept'
                  check (status in ('concept', 'in_production', 'ready', 'retired')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index components_type_idx     on library.components(type);
create index components_status_idx   on library.components(status);

comment on table library.components is
  'One row per atomic creative test variable. Type partitions the table into hook, body_angle, scene, and creator pools.';

-- ============================================================
-- 2. variants: a specific (hook, body_angle, scene, creator) combination + iteration
-- ============================================================
-- variant_id format: H4.2_BA-PROOF_S-OFFICE_OSO_v1

create table library.variants (
  id              uuid primary key default gen_random_uuid(),
  variant_id      text unique not null,
  hook_id         uuid not null references library.components(id),
  body_angle_id   uuid not null references library.components(id),
  scene_id        uuid not null references library.components(id),
  creator_id      uuid not null references library.components(id),
  iteration       int  not null default 1,
  status          text not null default 'planned'
                  check (status in ('planned', 'editing', 'ready', 'live', 'paused', 'killed', 'winner')),
  meta_ad_id      text,
  meta_ad_name    text,
  asset_url       text,
  notes           text,
  created_at      timestamptz not null default now(),
  launched_at     timestamptz,
  updated_at      timestamptz not null default now()
);

create index variants_status_idx     on library.variants(status);
create index variants_meta_ad_idx    on library.variants(meta_ad_id);
create index variants_hook_idx       on library.variants(hook_id);
create index variants_body_idx       on library.variants(body_angle_id);

comment on table library.variants is
  'One row per spliced final ad. variant_id encodes the four-variable combination + iteration. Once launched, meta_ad_id links to Meta Ads Manager.';

-- ============================================================
-- 3. performance_daily: Meta + HYROS metrics per variant per day
-- ============================================================

create table library.performance_daily (
  id              uuid primary key default gen_random_uuid(),
  variant_id      uuid not null references library.variants(id) on delete cascade,
  date            date not null,
  -- Meta delivery metrics
  spend           numeric(12,2) not null default 0,
  impressions    int not null default 0,
  reach           int not null default 0,
  clicks          int not null default 0,
  link_clicks     int not null default 0,
  three_sec_views int not null default 0,
  thruplays       int not null default 0,
  -- HYROS / business metrics
  leads           int not null default 0,
  booked_calls    int not null default 0,
  closes          int not null default 0,
  cash_collected  numeric(12,2) not null default 0,
  revenue         numeric(12,2) not null default 0,
  -- Source flag for debugging
  source          text not null default 'meta' check (source in ('meta', 'hyros', 'merged')),
  pulled_at       timestamptz not null default now(),
  unique(variant_id, date)
);

create index perf_variant_idx on library.performance_daily(variant_id);
create index perf_date_idx    on library.performance_daily(date);

comment on table library.performance_daily is
  'Daily performance snapshot per variant. Computed rates (hook_rate, hold_rate, ctr, cpl, cpa) live in views, not here, so they always reflect the latest aggregation logic.';

-- ============================================================
-- 4. legacy_ad_mapping: ads launched before the naming SOP
-- ============================================================

create table library.legacy_ad_mapping (
  id              uuid primary key default gen_random_uuid(),
  meta_ad_id      text unique not null,
  meta_ad_name    text,
  variant_id      uuid references library.variants(id),
  notes           text,
  retired         boolean not null default false,
  created_at      timestamptz not null default now()
);

comment on table library.legacy_ad_mapping is
  'Manual mapping table for the ~10 pre-SOP ads worth attributing. Anything not in this table OR not following the naming convention shows up in orphan_ads.';

-- ============================================================
-- 5. orphan_ads: Meta sync found an ad that does not match any variant
-- ============================================================

create table library.orphan_ads (
  id                 uuid primary key default gen_random_uuid(),
  meta_ad_id         text unique not null,
  meta_ad_name       text,
  first_seen         timestamptz not null default now(),
  last_seen          timestamptz not null default now(),
  parser_attempted   text,
  resolved           boolean not null default false
);

comment on table library.orphan_ads is
  'Ads found by the Meta sync job that do not match the naming convention and are not in legacy_ad_mapping. Surface in dashboard as alerts so operator can resolve.';

-- ============================================================
-- 6. updated_at trigger
-- ============================================================

create or replace function library.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger components_set_updated_at
  before update on library.components
  for each row execute function library.set_updated_at();

create trigger variants_set_updated_at
  before update on library.variants
  for each row execute function library.set_updated_at();

-- ============================================================
-- 7. component_performance materialized view
-- ============================================================
-- Weighted aggregation across all variants that use a component
-- (not avg-of-avgs, which would mislead on small-spend variants)

create materialized view library.component_performance as
select
  c.id                                        as component_id_uuid,
  c.component_id,
  c.type,
  c.label,
  c.status,
  count(distinct v.id)                        as variant_count,
  count(distinct case when v.status = 'live'  then v.id end) as live_variant_count,
  coalesce(sum(p.spend),         0)           as total_spend,
  coalesce(sum(p.impressions),   0)           as total_impressions,
  coalesce(sum(p.three_sec_views), 0)         as total_three_sec,
  coalesce(sum(p.thruplays),     0)           as total_thruplays,
  coalesce(sum(p.leads),         0)           as total_leads,
  coalesce(sum(p.booked_calls),  0)           as total_booked_calls,
  coalesce(sum(p.closes),        0)           as total_closes,
  coalesce(sum(p.cash_collected),0)           as total_cash,
  coalesce(sum(p.revenue),       0)           as total_revenue,
  -- Weighted rates
  case when sum(p.impressions) > 0
       then sum(p.three_sec_views)::numeric / sum(p.impressions)
  end                                         as weighted_hook_rate,
  case when sum(p.three_sec_views) > 0
       then sum(p.thruplays)::numeric / sum(p.three_sec_views)
  end                                         as weighted_hold_rate,
  case when sum(p.impressions) > 0
       then sum(p.clicks)::numeric / sum(p.impressions)
  end                                         as weighted_ctr,
  -- Cost metrics
  case when sum(p.leads)         > 0 then sum(p.spend) / sum(p.leads) end          as cpl,
  case when sum(p.booked_calls)  > 0 then sum(p.spend) / sum(p.booked_calls) end   as cpa,
  case when sum(p.closes)        > 0 then sum(p.spend) / sum(p.closes) end         as cost_per_close
from library.components c
left join library.variants v
       on v.hook_id        = c.id
       or v.body_angle_id  = c.id
       or v.scene_id       = c.id
       or v.creator_id     = c.id
left join library.performance_daily p on p.variant_id = v.id
group by c.id, c.component_id, c.type, c.label, c.status;

create unique index component_performance_pk on library.component_performance(component_id_uuid);

comment on materialized view library.component_performance is
  'Weighted performance across every variant that uses a component. Refresh via library.refresh_materialized_views().';

-- ============================================================
-- 8. cohort_hook_body materialized view
-- ============================================================
-- Hook x body_angle cohort matrix — most useful 2-variable cut

create materialized view library.cohort_hook_body as
select
  h.component_id                              as hook,
  b.component_id                              as body_angle,
  count(distinct v.id)                        as variant_count,
  coalesce(sum(p.spend),         0)           as spend,
  coalesce(sum(p.impressions),   0)           as impressions,
  coalesce(sum(p.three_sec_views), 0)         as three_sec,
  coalesce(sum(p.thruplays),     0)           as thruplays,
  coalesce(sum(p.leads),         0)           as leads,
  coalesce(sum(p.booked_calls),  0)           as booked_calls,
  coalesce(sum(p.closes),        0)           as closes,
  case when sum(p.impressions) > 0
       then sum(p.three_sec_views)::numeric / sum(p.impressions)
  end                                         as hook_rate,
  case when sum(p.three_sec_views) > 0
       then sum(p.thruplays)::numeric / sum(p.three_sec_views)
  end                                         as hold_rate,
  case when sum(p.booked_calls) > 0
       then sum(p.spend) / sum(p.booked_calls)
  end                                         as cpa
from library.variants v
join library.components h on v.hook_id       = h.id
join library.components b on v.body_angle_id = b.id
left join library.performance_daily p on p.variant_id = v.id
group by h.component_id, b.component_id;

create unique index cohort_hook_body_pk on library.cohort_hook_body(hook, body_angle);

-- ============================================================
-- 9. Refresh function (called by sync edge function on a cron)
-- ============================================================

create or replace function library.refresh_materialized_views()
returns void as $$
begin
  refresh materialized view concurrently library.component_performance;
  refresh materialized view concurrently library.cohort_hook_body;
end;
$$ language plpgsql;

-- ============================================================
-- 10. Seed canonical components (Body angles, Scenes, Creators)
-- ============================================================
-- Hooks are NOT seeded here because hook IDs are scripted-content-specific
-- and need real script_text. Operator adds hook entries via dashboard.

insert into library.components (component_id, type, label, description, status) values
  -- Body angles (canonical 7)
  ('BA-PROOF',     'body_angle', 'Proof',      'Named-client transformation story (Eric, Adam, Belinda)', 'ready'),
  ('BA-DATA',      'body_angle', 'Data',       'Number-led / industry-stat opener that builds to mechanism', 'ready'),
  ('BA-STORY',     'body_angle', 'Story',      'Narrative arc with character and outcome', 'ready'),
  ('BA-AUTHORITY', 'body_angle', 'Authority',  'Founder-mode / playbook / "if I started from scratch"', 'ready'),
  ('BA-TEACHING',  'body_angle', 'Teaching',   'Educational walk-through of a Google or local-SEO mechanism', 'ready'),
  ('BA-OFFER',     'body_angle', 'Offer',      'Direct guarantee / offer-statement, no story or proof', 'ready'),
  ('BA-COMPETITOR','body_angle', 'Competitor', 'Side-by-side comparison or competitor disqualification', 'ready'),
  -- Scenes (canonical 7)
  ('S-OFFICE',     'scene', 'Office',      'Talking head at a desk, branded backdrop', 'ready'),
  ('S-CAR',        'scene', 'Car',         'In-vehicle / dashcam framing', 'ready'),
  ('S-STUDIO',     'scene', 'Studio',      'Professionally lit setup, plain backdrop', 'ready'),
  ('S-OUTDOOR',   'scene', 'Outdoor',     'Natural light, exterior', 'ready'),
  ('S-ONSITE',     'scene', 'On-site',     'On a real job site (truck, equipment, customer property)', 'ready'),
  ('S-PHONE',      'scene', 'Phone',       'Selfie-style handheld', 'ready'),
  ('S-WHITEBOARD', 'scene', 'Whiteboard',  'With diagram or visual aid in shot', 'ready'),
  -- Creators
  ('OSO',          'creator', 'Oso',          'UGC creator, primary',     'ready'),
  ('SOFIA',        'creator', 'Sofia',        'UGC creator, primary',     'ready'),
  ('NATALIE',      'creator', 'Natalie',      'UGC creator, primary',     'ready'),
  ('RESTO-AI',     'creator', 'Restoration AI','AI-generated restoration scripts', 'ready'),
  ('CLIENT',       'creator', 'Client',       'Direct client testimonial, no creator wrapper', 'ready')
on conflict (component_id) do nothing;

-- ============================================================
-- 11. RLS policies
-- ============================================================
-- Pattern: authenticated users read; only service_role writes (via Edge Functions)
-- Matches the existing sales-dashboard convention.

alter table library.components         enable row level security;
alter table library.variants            enable row level security;
alter table library.performance_daily   enable row level security;
alter table library.legacy_ad_mapping   enable row level security;
alter table library.orphan_ads          enable row level security;

create policy "auth read components"  on library.components
  for select using (auth.role() = 'authenticated' or auth.role() = 'service_role');
create policy "auth read variants"    on library.variants
  for select using (auth.role() = 'authenticated' or auth.role() = 'service_role');
create policy "auth read performance" on library.performance_daily
  for select using (auth.role() = 'authenticated' or auth.role() = 'service_role');
create policy "auth read legacy"      on library.legacy_ad_mapping
  for select using (auth.role() = 'authenticated' or auth.role() = 'service_role');
create policy "auth read orphans"     on library.orphan_ads
  for select using (auth.role() = 'authenticated' or auth.role() = 'service_role');

-- Service-role write policies (Edge Functions use service-role key)
create policy "service write components"  on library.components
  for all using (auth.role() = 'service_role');
create policy "service write variants"    on library.variants
  for all using (auth.role() = 'service_role');
create policy "service write performance" on library.performance_daily
  for all using (auth.role() = 'service_role');
create policy "service write legacy"      on library.legacy_ad_mapping
  for all using (auth.role() = 'service_role');
create policy "service write orphans"     on library.orphan_ads
  for all using (auth.role() = 'service_role');

-- ============================================================
-- 12. Grant access to authenticated + anon roles for read
-- ============================================================

grant usage on schema library to authenticated, anon, service_role;
grant select on all tables    in schema library to authenticated, anon;
grant all    on all tables    in schema library to service_role;
grant select on library.component_performance to authenticated, anon, service_role;
grant select on library.cohort_hook_body      to authenticated, anon, service_role;

-- Tell PostgREST to reload its schema cache
notify pgrst, 'reload schema';
