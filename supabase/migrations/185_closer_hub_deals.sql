-- 185: Closer Hub deals as a checklist (Ben, 12 Sep 2026)
--
-- "make it more like a little checklist and automate what we can with payment
-- links / pages, contract etc and tickboxes for things". A deal is saved as
-- soon as it has a company, so the checklist survives a reload and a closer
-- can pick it up again after the call.

create table if not exists closer_hub_deals (
  id            uuid primary key default gen_random_uuid(),
  created_by    uuid not null,
  closer_name   text,
  company       text not null,
  email         text,
  client_name   text,
  offer         text not null default 'retainer',
  template      text,
  fee           text,
  extra         text,
  signer_email  text,
  ticks         jsonb not null default '{}'::jsonb,   -- {payment: true, guest: true, ...}
  data          jsonb not null default '{}'::jsonb,   -- contract, channels, payment link, ghl result
  status        text not null default 'open',         -- open | done
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists closer_hub_deals_owner_idx on closer_hub_deals (created_by, status, updated_at desc);

alter table closer_hub_deals enable row level security;
drop policy if exists closer_hub_deals_read   on closer_hub_deals;
drop policy if exists closer_hub_deals_insert on closer_hub_deals;
drop policy if exists closer_hub_deals_update on closer_hub_deals;
create policy closer_hub_deals_read   on closer_hub_deals for select to authenticated
  using (closer_hub_allowed() and (created_by = auth.uid() or closer_hub_is_admin()));
create policy closer_hub_deals_insert on closer_hub_deals for insert to authenticated
  with check (closer_hub_allowed() and created_by = auth.uid());
create policy closer_hub_deals_update on closer_hub_deals for update to authenticated
  using (closer_hub_allowed() and (created_by = auth.uid() or closer_hub_is_admin()))
  with check (created_by = auth.uid() or closer_hub_is_admin());
grant select, insert, update on closer_hub_deals to authenticated;
grant all on closer_hub_deals to service_role;

-- Payment links and the form link, set by an admin on the hub.
insert into closer_hub_settings (key, value) values
  ('pay_link_trial',       ''),   -- Commas checkout page for the $997 trial
  ('pay_link_retainer',    ''),   -- Commas checkout page for the retainer
  ('pay_product_trial',    ''),   -- or a Commas product id, picked on the hub
  ('pay_product_retainer', ''),
  ('stripe_currency',      'usd'),
  ('onboarding_form_url',  'https://onboard.optdigital.io/onboardingwd')
on conflict (key) do nothing;

notify pgrst, 'reload schema';
