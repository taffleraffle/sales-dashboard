-- 148: create tables/columns the frontend already queries but that were
-- never migrated. Each of these 400'd via PostgREST and the error was
-- swallowed, leaving silently-empty (or silently-wrong) UI. Found by the
-- 2026-06-10 full schema-vs-code audit.

-- 1. closer_calls.ghl_event_id — EODReview/EODDashboard/CloserDetail all
-- select it to dedupe calendar appointments against saved calls (without
-- it every appointment re-counts as a "new call" in review badges). The
-- column was designed into the UI state but never migrated; the insert
-- path now writes it too (same PR).
alter table public.closer_calls add column if not exists ghl_event_id text;
create index if not exists idx_closer_calls_ghl_event on public.closer_calls (ghl_event_id) where ghl_event_id is not null;

-- 2. payment_blacklist — usePaymentBlacklist + CommissionPage filter
-- commission payments against these patterns. Table never existed, so the
-- blacklist was always empty and commission totals INCLUDED payments that
-- should have been excluded (money-correctness bug), and the add/remove
-- UI silently no-opped.
create table if not exists public.payment_blacklist (
  id uuid primary key default gen_random_uuid(),
  pattern text not null,
  match_field text not null,
  created_by text,
  created_at timestamptz not null default now()
);

-- 3. ghl_contacts_cache — name/email cache so EmailFlows and the
-- MarketingPerformance contact-resolution path skip the live GHL API hop.
-- Without it, prewarmRecipientNameCache re-fetched up to 200 contacts from
-- GHL on every EmailFlows mount (silent quota burn) and recipients showed
-- as "Contact xxxxxxxx" until each live fetch resolved.
create table if not exists public.ghl_contacts_cache (
  id text primary key,
  name text,
  email text,
  synced_at timestamptz not null default now()
);
