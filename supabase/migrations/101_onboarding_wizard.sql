-- =============================================================
-- Onboarding Wizard schema (migration 101)
-- =============================================================
-- Powers /clients/new — the multi-step elite onboarding flow.
-- Designed so onboarding specialists (SEO, content, GBP, compliance, AM)
-- can each contribute suggestions BEFORE site provisioning runs.
--
-- Data model:
--   onboarding_sessions     — one per wizard run, full lifecycle state
--   onboarding_sources      — every input source (Fathom call, GHL contact, crawl, GBP, etc.)
--   onboarding_artifacts    — Anthropic-generated outputs by section (11 sections from
--                              client-onboarding-questions.md)
--   onboarding_suggestions  — per-session specialist input (notes, override, addition)
--   specialist_playbooks    — standing rules per vertical/role that auto-apply
--   onboarding_audit_log    — every change, who, when, why
--   onboarding_quality_gates — pre-launch checks that must pass
--
-- Voice rules (ROM standard) ALWAYS apply to generated content:
--   no em-dashes, no AI slop, direct-answer 40-60w paragraphs, specific not vague.

-- =============================================================
-- 1. sessions
-- =============================================================
create table if not exists onboarding_sessions (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid references agencies(id) default default_rom_agency_id(),
  client_id         uuid references clients(id) on delete set null,
  initiated_by      text not null,
  status            text not null default 'sources' check (status in (
    'sources','extracting','review','specialist','preview','launching','launched','aborted'
  )),
  -- The slug is reserved when the wizard starts so concurrent wizards
  -- don't collide on the same client name.
  reserved_slug     text unique,
  business_name_draft text,
  vertical_draft    text,

  -- Free-text reason if aborted
  abort_reason      text,

  started_at        timestamptz default now(),
  completed_at      timestamptz,
  launched_at       timestamptz,
  last_active_at    timestamptz default now()
);

create index if not exists idx_onboarding_sessions_status on onboarding_sessions(status) where status not in ('launched','aborted');
create index if not exists idx_onboarding_sessions_client on onboarding_sessions(client_id);

-- =============================================================
-- 2. sources — every input we ingest into the wizard
-- =============================================================
create table if not exists onboarding_sources (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid references onboarding_sessions(id) on delete cascade,
  source_type       text not null check (source_type in (
    'fathom_transcript',   -- sales/onboarding call
    'ghl_contact',          -- GHL CRM record + custom fields
    'site_crawl',           -- their existing website
    'gbp_profile',          -- Google Business Profile data
    'bbb_profile',          -- BBB record
    'yelp_profile',         -- Yelp business
    'linkedin_company',     -- LinkedIn company page
    'dataforseo_scan',      -- ranking + competitor data
    'whatconverts_history', -- existing lead data if previously tracked
    'manual_paste',         -- operator pasted text
    'asset_upload'          -- photo/doc upload
  )),
  source_ref        text,    -- external id, URL, or path
  fetched_at        timestamptz default now(),
  fetched_by        text,
  raw_content       jsonb default '{}'::jsonb,
  parsed_summary    text,    -- short human-readable snapshot
  byte_size         integer,
  status            text default 'fetched' check (status in ('fetched','parsing','parsed','failed','skipped'))
);

create index if not exists idx_onboarding_sources_session on onboarding_sources(session_id);

-- =============================================================
-- 3. artifacts — the AI-extracted output, ONE row per section
--    Section names map to client-onboarding-questions.md
-- =============================================================
create table if not exists onboarding_artifacts (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid references onboarding_sessions(id) on delete cascade,
  section_key       text not null check (section_key in (
    'business_model',          -- 01 commercial reality
    'services_catalog',        -- 02 services in detail
    'customer_profile',        -- 03 patient/customer
    'authority_eeat',          -- 04 E-E-A-T spine
    'geography',               -- 05 service area
    'existing_assets',         -- 06 content + assets to mine
    'competitors',             -- 07 competitive landscape
    'conversion_mechanics',    -- 08 close rates, sales process
    'compliance',              -- 09 what they can't say
    'brand_voice',             -- 10 voice + the human
    'logistics',               -- 11 wrap-up logistics
    'founder_bio',             -- deep founder profile
    'signature_specialties',   -- what makes them elite
    'commercial_terms',        -- pricing, contract, trial path
    'stakeholders',            -- decision-makers + comms routing
    'photo_assets',            -- what photos exist + what's needed
    'tracking_setup',          -- existing GA4/WC/GBP state
    'initial_gameplan'         -- the strategic plan distilled
  )),

  -- Confidence + provenance
  confidence        numeric(3,2) check (confidence >= 0 and confidence <= 1),
  source_ids        uuid[] default '{}',  -- which onboarding_sources informed this
  inferred          boolean default false, -- true = AI guessed, false = directly stated

  -- The actual data
  data              jsonb not null default '{}'::jsonb,
  rendered_md       text,  -- markdown rendering for human review

  -- Edit state
  approved_by       text,
  approved_at       timestamptz,
  edited_by         text,
  edited_at         timestamptz,

  created_at        timestamptz default now(),

  unique(session_id, section_key)
);

create index if not exists idx_onboarding_artifacts_session on onboarding_artifacts(session_id);

-- =============================================================
-- 4. specialist suggestions — per-session input from specialists
-- =============================================================
create table if not exists onboarding_suggestions (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid references onboarding_sessions(id) on delete cascade,
  artifact_id       uuid references onboarding_artifacts(id) on delete cascade,
  section_key       text,   -- nullable if suggestion is cross-section

  specialist_role   text not null check (specialist_role in (
    'seo','content','gbp','compliance','citations','am','closer','founder','technical','other'
  )),
  specialist_user   text not null,

  suggestion_type   text not null check (suggestion_type in ('note','override','addition','flag','blocker')),
  title             text not null,
  body              text,
  applied           boolean default false,
  applied_at        timestamptz,
  applied_by        text,
  dismissed_at      timestamptz,
  dismissed_reason  text,

  -- Suggestions can include structured JSON if they target specific data
  patch             jsonb default null,

  created_at        timestamptz default now()
);

create index if not exists idx_onboarding_suggestions_session on onboarding_suggestions(session_id);
create index if not exists idx_onboarding_suggestions_open on onboarding_suggestions(session_id, applied) where dismissed_at is null;

-- =============================================================
-- 5. specialist playbooks — standing rules by vertical+role
--    These auto-apply at extraction time and surface as suggestions.
-- =============================================================
create table if not exists specialist_playbooks (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid references agencies(id) default default_rom_agency_id(),
  vertical          text not null,
  specialist_role   text not null,
  title             text not null,
  body              text not null,
  patch             jsonb default null,  -- optional structured rule applied as patch
  priority          integer default 50,  -- higher = applied first
  active            boolean default true,
  created_by        text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists idx_specialist_playbooks_vertical on specialist_playbooks(vertical, specialist_role, active);

-- =============================================================
-- 6. quality gates — what must pass before launch
-- =============================================================
create table if not exists onboarding_quality_gates (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid references onboarding_sessions(id) on delete cascade,
  gate_key          text not null check (gate_key in (
    'extraction_complete',     -- all 18 sections have non-empty data
    'no_placeholders',         -- no [TBC] in critical fields
    'voice_lint_passed',       -- no em-dashes, no AI slop, paragraph length
    'schema_lints',            -- vertical-specific schema requirements
    'compliance_lints',        -- vertical-specific compliance (HIPAA/bar/FTC)
    'photos_minimum',          -- >= N photos uploaded
    'stakeholder_mapped',      -- owner identified with channels
    'commercial_locked',       -- fee + tier + path agreed
    'specialist_signoff_seo',
    'specialist_signoff_content',
    'specialist_signoff_compliance',
    'specialist_signoff_am'
  )),
  status            text default 'pending' check (status in ('pending','passed','failed','waived')),
  details           jsonb default '{}'::jsonb,
  checked_at        timestamptz,
  waived_by         text,
  waived_reason     text,
  unique(session_id, gate_key)
);

-- =============================================================
-- 7. audit log — every change, every actor
-- =============================================================
create table if not exists onboarding_audit_log (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid references onboarding_sessions(id) on delete cascade,
  actor             text not null,
  action            text not null,
  target_kind       text,
  target_id         uuid,
  before_value      jsonb,
  after_value       jsonb,
  context           text,
  created_at        timestamptz default now()
);

create index if not exists idx_onboarding_audit_session on onboarding_audit_log(session_id, created_at desc);

-- =============================================================
-- 8. provisioning steps — what gets created when wizard launches
-- =============================================================
create table if not exists onboarding_provisioning_steps (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid references onboarding_sessions(id) on delete cascade,
  step_key          text not null check (step_key in (
    'create_ghl_opportunity',
    'create_slack_channel_client',
    'create_slack_channel_internal',
    'provision_quo_number',
    'create_drive_folder',
    'create_github_repo',
    'create_cloudflare_pages_project',
    'materialize_onboarding_touchpoints',
    'create_client_row',
    'create_stakeholder_rows',
    'queue_brightlocal_citations',
    'create_results_portal_account',
    'send_welcome_email',
    'send_questionnaire',
    'fire_kickoff_event'
  )),
  status            text default 'pending' check (status in ('pending','running','succeeded','failed','skipped')),
  attempts          integer default 0,
  error             text,
  output            jsonb default '{}'::jsonb,
  started_at        timestamptz,
  completed_at      timestamptz,
  unique(session_id, step_key)
);

-- =============================================================
-- RLS
-- =============================================================
alter table onboarding_sessions enable row level security;
alter table onboarding_sources enable row level security;
alter table onboarding_artifacts enable row level security;
alter table onboarding_suggestions enable row level security;
alter table specialist_playbooks enable row level security;
alter table onboarding_quality_gates enable row level security;
alter table onboarding_audit_log enable row level security;
alter table onboarding_provisioning_steps enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array[
    'onboarding_sessions','onboarding_sources','onboarding_artifacts',
    'onboarding_suggestions','specialist_playbooks','onboarding_quality_gates',
    'onboarding_audit_log','onboarding_provisioning_steps'
  ])
  loop
    execute format('drop policy if exists "auth_all_%I" on %I', t, t);
    execute format('create policy "auth_all_%I" on %I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end$$;

-- =============================================================
-- Seed: a few specialist playbooks for roofing + HVAC verticals
-- =============================================================
insert into specialist_playbooks (vertical, specialist_role, title, body, priority) values
  ('roofing','seo','Always include hail-damage as a service','Hail-damage service page is the #1 organic lead-generator in TX/OK/CO. Include even if client says they "do it occasionally" — frame it as a featured insurance-claim specialty.',90),
  ('roofing','seo','Cluster around 3 material types','Asphalt shingle + standing seam metal + tile/synthetic slate are the canonical 3 clusters for roofing organic search. If client only mentions 1, ask which others they install + add at least 2 service pages.',85),
  ('roofing','content','Lead with manufacturer certifications','IKO/Decra/DaVinci/GAF certifications drive E-E-A-T. Anchor founder bio + service pages around the highest-tier cert held.',80),
  ('roofing','gbp','Categories: Roofing Contractor + 4 sub-categories','Primary GBP category: "Roofing contractor". Secondary 4: "Roofing service", "Roofing supply store" (if applicable), "Gutter cleaning service" (if offered), "Metal fabricator" (if metal install).',75),
  ('roofing','compliance','Insurance discount claims need policy citation','When claiming "10-20% Texas insurance discount on Class 4 roof", always cite Texas Department of Insurance + name 1+ carrier. Never state as fact without source.',95),
  ('hvac','seo','Cluster around tune-up + repair + replacement + IAQ','HVAC organic SERPs cluster around four pillars: tune-up/maintenance, emergency repair, full replacement, indoor air quality. Need a service page for each.',90),
  ('hvac','seo','Furnace + AC + heat pump separately','In most US markets, separate service pages for furnace, AC, and heat pump beat one combined "HVAC services" page. Force the split unless client only services one type.',85),
  ('hvac','gbp','Primary category: HVAC contractor','Use "HVAC contractor" not "Air conditioning contractor" — broader, captures heating + cooling.',75),
  ('hvac','compliance','EPA certification claims','If client claims EPA 608 certification, verify number on EPA website + include cert number on Authority page.',95);

-- =============================================================
-- Audit log trigger — capture every artifact update
-- =============================================================
create or replace function log_artifact_change() returns trigger language plpgsql as $$
begin
  insert into onboarding_audit_log (session_id, actor, action, target_kind, target_id, before_value, after_value)
  values (
    new.session_id,
    coalesce(new.edited_by, new.approved_by, 'system'),
    case when (tg_op = 'INSERT') then 'create_artifact'
         when new.approved_at is not null and (old.approved_at is null or old.approved_at <> new.approved_at) then 'approve_artifact'
         else 'edit_artifact' end,
    'onboarding_artifact',
    new.id,
    case when tg_op = 'UPDATE' then row_to_json(old)::jsonb else null end,
    row_to_json(new)::jsonb
  );
  return new;
end$$;

drop trigger if exists trg_log_artifact_change on onboarding_artifacts;
create trigger trg_log_artifact_change after insert or update on onboarding_artifacts
  for each row execute function log_artifact_change();
