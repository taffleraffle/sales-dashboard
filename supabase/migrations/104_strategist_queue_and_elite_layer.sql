-- Elite layer: strategist queue + content factory + AI visibility + GBP + citations + roadmaps
-- Spine: every AI output routes through strategist_queue. Nothing client-facing publishes without approval.

-- =============================================================
-- 1. strategist_queue (the spine)
-- =============================================================
create table if not exists strategist_queue (
  id              uuid primary key default gen_random_uuid(),
  agency_id       uuid references agencies(id) default default_rom_agency_id(),
  client_id       uuid references clients(id) on delete cascade,
  kind            text not null check (kind in (
    'content_brief',
    'content_draft',
    'gbp_post',
    'citation_target',
    'weekly_recap_curation',
    'ai_visibility_report',
    'roadmap_update',
    'competitor_brief',
    'win_curation',
    'red_flag_review',
    'health_check_followup'
  )),
  priority        integer not null default 50 check (priority between 0 and 100),
  proposed_payload jsonb not null default '{}'::jsonb,
  strategist_overrides jsonb default '{}'::jsonb,
  final_payload   jsonb default '{}'::jsonb,
  status          text not null default 'pending' check (status in (
    'pending', 'approved', 'amended', 'rejected', 'published', 'expired', 'escalated'
  )),
  strategist_id   uuid,
  strategist_name text default 'Mersad',
  strategist_notes text,
  reviewed_at     timestamptz,
  published_at    timestamptz,
  escalated_at    timestamptz,
  source_function text,
  source_payload  jsonb default '{}'::jsonb,
  expires_at      timestamptz default (now() + interval '48 hours'),
  created_at      timestamptz default now()
);

create index if not exists idx_sq_status_priority on strategist_queue(status, priority desc, created_at);
create index if not exists idx_sq_client on strategist_queue(client_id, created_at desc);
create index if not exists idx_sq_kind on strategist_queue(kind, status);

-- =============================================================
-- 2. content_briefs (output of brief-generator)
-- =============================================================
create table if not exists content_briefs (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  queue_id        uuid references strategist_queue(id) on delete set null,
  target_keyword  text not null,
  search_intent   text check (search_intent in ('informational','commercial','transactional','navigational','local')),
  search_volume   integer,
  difficulty      integer,
  current_position integer,
  target_position integer default 5,
  serp_competitors jsonb default '[]'::jsonb,
  serp_features   jsonb default '[]'::jsonb,
  outline         jsonb default '[]'::jsonb,
  entities        jsonb default '[]'::jsonb,
  schema_requirements jsonb default '[]'::jsonb,
  internal_links  jsonb default '[]'::jsonb,
  word_count_target integer default 1800,
  tone_notes      text,
  voice_rules     text,
  writer_assigned text,
  status          text default 'briefed' check (status in (
    'briefed', 'assigned', 'drafting', 'in_qa', 'awaiting_strategist',
    'approved', 'published', 'indexed', 'ranking', 'archived'
  )),
  draft_url       text,
  published_url   text,
  published_at    timestamptz,
  indexed_at      timestamptz,
  ranking_started_at timestamptz,
  best_position   integer,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists idx_briefs_client on content_briefs(client_id, created_at desc);
create index if not exists idx_briefs_status on content_briefs(status);

-- =============================================================
-- 3. content_drafts (writer + editor outputs)
-- =============================================================
create table if not exists content_drafts (
  id              uuid primary key default gen_random_uuid(),
  brief_id        uuid references content_briefs(id) on delete cascade,
  client_id       uuid references clients(id) on delete cascade,
  draft_number    integer default 1,
  body_md         text,
  word_count      integer,
  writer          text,
  editor_qa       jsonb default '{}'::jsonb,
  qa_score        integer check (qa_score between 0 and 100),
  qa_verdict      text check (qa_verdict in ('approve','revise','reject')),
  required_fixes  jsonb default '[]'::jsonb,
  submitted_at    timestamptz default now()
);

create index if not exists idx_drafts_brief on content_drafts(brief_id, draft_number);

-- =============================================================
-- 4. ai_visibility_reports (per-platform citation tracking)
-- =============================================================
create table if not exists ai_visibility_reports (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  week_starting   date not null,
  platform        text not null check (platform in ('chatgpt','perplexity','gemini','claude','google_aio','bing_copilot')),
  query           text not null,
  client_cited    boolean default false,
  client_citation_excerpt text,
  competitors_cited jsonb default '[]'::jsonb,
  total_citations integer default 0,
  raw_response    text,
  fetched_at      timestamptz default now(),
  unique(client_id, week_starting, platform, query)
);

create index if not exists idx_aivr_client_week on ai_visibility_reports(client_id, week_starting desc);

-- =============================================================
-- 5. gbp_health_log (daily GBP audit)
-- =============================================================
create table if not exists gbp_health_log (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  date            date not null,
  posts_last_7d   integer default 0,
  photos_last_7d  integer default 0,
  qa_pending      integer default 0,
  qa_avg_response_hours numeric(8,2),
  reviews_last_7d integer default 0,
  reviews_avg_rating numeric(3,2),
  attributes_drift jsonb default '[]'::jsonb,
  hours_drift     boolean default false,
  flags           jsonb default '[]'::jsonb,
  score           integer check (score between 0 and 100),
  checked_at      timestamptz default now(),
  unique(client_id, date)
);

create index if not exists idx_gbp_health_client on gbp_health_log(client_id, date desc);

-- =============================================================
-- 6. citation_audits (BrightLocal NAP sync)
-- =============================================================
create table if not exists citation_audits (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  audit_date      date not null,
  total_listings  integer default 0,
  exact_match     integer default 0,
  partial_match   integer default 0,
  missing_listings integer default 0,
  drift_detected  jsonb default '[]'::jsonb,
  brightlocal_report_url text,
  checked_at      timestamptz default now()
);

create index if not exists idx_citations_client on citation_audits(client_id, audit_date desc);

-- =============================================================
-- 7. client_roadmaps (per-client 90-day plans)
-- =============================================================
create table if not exists client_roadmaps (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  generated_at    timestamptz default now(),
  effective_from  date,
  effective_to    date,
  vision          text,
  competitive_positioning text,
  three_pillars   jsonb default '[]'::jsonb,
  phase_plan      jsonb default '[]'::jsonb,
  measurable_targets jsonb default '[]'::jsonb,
  competitors_tracked jsonb default '[]'::jsonb,
  client_visible_summary text,
  internal_full_payload jsonb default '{}'::jsonb,
  status          text default 'draft' check (status in ('draft','approved','live','superseded')),
  superseded_by   uuid references client_roadmaps(id),
  approved_by     text,
  approved_at     timestamptz
);

create index if not exists idx_roadmaps_client on client_roadmaps(client_id, generated_at desc);
create index if not exists idx_roadmaps_status on client_roadmaps(status);

-- =============================================================
-- 8. competitor_briefs (weekly competitor watchdog output)
-- =============================================================
create table if not exists competitor_briefs (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  week_starting   date not null,
  competitor_domain text not null,
  movements       jsonb default '[]'::jsonb,
  new_content     jsonb default '[]'::jsonb,
  new_backlinks   integer default 0,
  ranking_changes jsonb default '[]'::jsonb,
  threat_score    integer check (threat_score between 0 and 100),
  recommended_response text,
  generated_at    timestamptz default now(),
  unique(client_id, week_starting, competitor_domain)
);

create index if not exists idx_compbriefs_client_week on competitor_briefs(client_id, week_starting desc);

-- =============================================================
-- 9. narrative_curation_rules (controlled narrative engine)
-- =============================================================
create table if not exists narrative_curation_rules (
  id              uuid primary key default gen_random_uuid(),
  agency_id       uuid references agencies(id) default default_rom_agency_id(),
  rule_kind       text not null check (rule_kind in (
    'suppress_negative_delta',
    'pair_with_response',
    'lead_with_metric',
    'hide_unless_above_threshold',
    'require_strategist_approval'
  )),
  applies_to      text not null,
  threshold       jsonb default '{}'::jsonb,
  narrative_template text,
  active          boolean default true,
  created_at      timestamptz default now()
);

-- Seed default narrative rules
insert into narrative_curation_rules (rule_kind, applies_to, threshold, narrative_template)
values
  ('suppress_negative_delta', 'rank_drop', '{"min_positions": 3}'::jsonb,
   'Refining our targeting on {keyword} this week. New content brief in the pipeline.'),
  ('require_strategist_approval', 'weekly_recap', '{"any_negative": true}'::jsonb, null),
  ('hide_unless_above_threshold', 'organic_sessions', '{"min": 50}'::jsonb, null),
  ('pair_with_response', 'gbp_review_drop', '{"min_rating_delta": -0.2}'::jsonb,
   'Response sequence already in motion. New review request batch sending Friday.')
on conflict do nothing;

-- =============================================================
-- 10. RLS
-- =============================================================
alter table strategist_queue enable row level security;
alter table content_briefs enable row level security;
alter table content_drafts enable row level security;
alter table ai_visibility_reports enable row level security;
alter table gbp_health_log enable row level security;
alter table citation_audits enable row level security;
alter table client_roadmaps enable row level security;
alter table competitor_briefs enable row level security;
alter table narrative_curation_rules enable row level security;

do $$ begin
  drop policy if exists "auth read sq" on strategist_queue;
  create policy "auth read sq" on strategist_queue for select to authenticated using (true);
  drop policy if exists "auth write sq" on strategist_queue;
  create policy "auth write sq" on strategist_queue for update to authenticated using (true);

  drop policy if exists "auth read briefs" on content_briefs;
  create policy "auth read briefs" on content_briefs for select to authenticated using (true);
  drop policy if exists "auth write briefs" on content_briefs;
  create policy "auth write briefs" on content_briefs for update to authenticated using (true);

  drop policy if exists "auth read drafts" on content_drafts;
  create policy "auth read drafts" on content_drafts for select to authenticated using (true);

  drop policy if exists "auth read aivr" on ai_visibility_reports;
  create policy "auth read aivr" on ai_visibility_reports for select to authenticated using (true);

  drop policy if exists "auth read gbphealth" on gbp_health_log;
  create policy "auth read gbphealth" on gbp_health_log for select to authenticated using (true);

  drop policy if exists "auth read citations" on citation_audits;
  create policy "auth read citations" on citation_audits for select to authenticated using (true);

  drop policy if exists "auth read roadmaps" on client_roadmaps;
  create policy "auth read roadmaps" on client_roadmaps for select to authenticated using (true);
  drop policy if exists "auth write roadmaps" on client_roadmaps;
  create policy "auth write roadmaps" on client_roadmaps for update to authenticated using (true);

  drop policy if exists "auth read compbriefs" on competitor_briefs;
  create policy "auth read compbriefs" on competitor_briefs for select to authenticated using (true);

  drop policy if exists "auth read nrules" on narrative_curation_rules;
  create policy "auth read nrules" on narrative_curation_rules for select to authenticated using (true);
end $$;

-- =============================================================
-- 11. Helper view: strategist morning queue
-- =============================================================
create or replace view strategist_morning_queue as
select
  sq.id,
  sq.kind,
  sq.priority,
  sq.client_id,
  c.business_name,
  c.primary_city,
  c.vertical,
  sq.proposed_payload,
  sq.created_at,
  sq.expires_at,
  case
    when sq.expires_at < now() then 'overdue'
    when sq.expires_at < now() + interval '12 hours' then 'urgent'
    else 'normal'
  end as urgency
from strategist_queue sq
left join clients c on c.id = sq.client_id
where sq.status = 'pending'
order by
  case
    when sq.expires_at < now() then 0
    when sq.priority >= 80 then 1
    else 2
  end,
  sq.priority desc,
  sq.created_at;

notify pgrst, 'reload schema';
