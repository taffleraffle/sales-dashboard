-- Multi-account Google OAuth support
-- Allows an agency to connect multiple Google accounts (hello@, daniel@, etc)
-- and route per-client GBP/GA4/GSC API calls through whichever account has access.

create table if not exists google_oauth_accounts (
  id              uuid primary key default gen_random_uuid(),
  agency_id       uuid references agencies(id) default default_rom_agency_id(),
  email           text not null,
  display_name    text,
  refresh_token   text not null,
  client_id       text not null,
  client_secret   text not null,
  scopes          text[] default '{}',
  is_primary      boolean default false,
  last_validated_at timestamptz,
  last_error      text,
  created_at      timestamptz default now(),
  unique(agency_id, email)
);

create index if not exists idx_goa_agency on google_oauth_accounts(agency_id);

-- Per-client account preference (which email manages this GBP)
-- Stored in clients.client_json.gbp_oauth_account for backwards compatibility;
-- this view exposes it for easy querying.
create or replace view client_gbp_account_map as
select
  c.id as client_id,
  c.business_name,
  coalesce(c.client_json->>'gbp_oauth_account', 'hello@rankonmaps.io') as preferred_email
from clients c;

-- Helper function — get all active OAuth accounts for an agency, primary first
create or replace function get_agency_oauth_accounts(p_agency_id uuid)
returns table (email text, refresh_token text, client_id text, client_secret text, is_primary boolean)
language sql stable as $$
  select email, refresh_token, client_id, client_secret, is_primary
  from google_oauth_accounts
  where agency_id = p_agency_id and last_error is null
  order by is_primary desc, last_validated_at desc nulls last;
$$;

-- Seed placeholder row for hello@. Real client_id, client_secret, and refresh_token must be
-- filled in via post-deploy SQL using the values from .env.local (GOOGLE_CLIENT_ID,
-- GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN). DO NOT commit those values to git — they live
-- in Supabase secrets + the local .env.local only.
insert into google_oauth_accounts (agency_id, email, display_name, refresh_token, client_id, client_secret, scopes, is_primary)
values (
  default_rom_agency_id(),
  'hello@rankonmaps.io',
  'Hello (agency identity, primary)',
  'SET_VIA_POST_DEPLOY_SCRIPT',
  'SET_VIA_POST_DEPLOY_SCRIPT',
  'SET_VIA_POST_DEPLOY_SCRIPT',
  array['https://www.googleapis.com/auth/business.manage','https://www.googleapis.com/auth/webmasters','https://www.googleapis.com/auth/indexing','https://www.googleapis.com/auth/analytics.edit','https://www.googleapis.com/auth/analytics.readonly','https://www.googleapis.com/auth/analytics.manage.users'],
  true
)
on conflict (agency_id, email) do nothing;

-- Post-deploy step (run manually with real values, not committed to git):
--   update google_oauth_accounts
--   set client_id = '<from .env.local GOOGLE_CLIENT_ID>',
--       client_secret = '<from .env.local GOOGLE_CLIENT_SECRET>',
--       refresh_token = '<from .env.local GOOGLE_REFRESH_TOKEN>'
--   where email = 'hello@rankonmaps.io';

alter table google_oauth_accounts enable row level security;
drop policy if exists "auth read goa" on google_oauth_accounts;
create policy "auth read goa" on google_oauth_accounts for select to authenticated using (true);

notify pgrst, 'reload schema';
