-- 184: Closer Hub (Ben, 12 Sep 2026)
--
-- One page for closers: tool links, the shared Semrush login, "Make Channel"
-- and a PandaDoc contract from just an email and a company name.
--
-- closer_hub_settings holds the editable bits (standard special conditions,
-- who signs for OPT, template ids, fees). No secrets live here: the PandaDoc
-- key and the Semrush password are edge-function secrets.
-- closer_hub_actions is the audit trail: who made which channel or contract.

create table if not exists closer_hub_settings (
  key         text primary key,
  value       text not null default '',
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

create table if not exists closer_hub_actions (
  id                  uuid primary key default gen_random_uuid(),
  actor_auth_user_id  uuid,
  actor_name          text,
  action              text not null,
  client_name         text,
  client_email        text,
  ok                  boolean,
  result              jsonb,
  created_at          timestamptz not null default now()
);
create index if not exists closer_hub_actions_created_idx on closer_hub_actions (created_at desc);

-- Who may use the hub: admins and managers, plus active closers.
create or replace function closer_hub_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_profiles p
                  where p.auth_user_id = auth.uid() and p.role in ('admin', 'manager'))
      or exists (select 1 from team_members t
                  where t.auth_user_id = auth.uid() and t.role = 'closer'
                    and coalesce(t.is_active, true));
$$;

create or replace function closer_hub_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_profiles p
                  where p.auth_user_id = auth.uid() and p.role in ('admin', 'manager'));
$$;

alter table closer_hub_settings enable row level security;
alter table closer_hub_actions  enable row level security;

drop policy if exists closer_hub_settings_read  on closer_hub_settings;
drop policy if exists closer_hub_settings_write on closer_hub_settings;
drop policy if exists closer_hub_actions_read   on closer_hub_actions;

create policy closer_hub_settings_read  on closer_hub_settings for select to authenticated using (closer_hub_allowed());
create policy closer_hub_settings_write on closer_hub_settings for all    to authenticated
  using (closer_hub_is_admin()) with check (closer_hub_is_admin());
create policy closer_hub_actions_read   on closer_hub_actions  for select to authenticated
  using (closer_hub_is_admin() or actor_auth_user_id = auth.uid());

grant select, insert, update on closer_hub_settings to authenticated;
grant select on closer_hub_actions to authenticated;
grant all on closer_hub_settings, closer_hub_actions to service_role;

-- Defaults. The conditions text goes into a legal document, so Ben reviews it
-- on the hub's admin panel; these are drawn from the offer SOP (C1-02).
insert into closer_hub_settings (key, value) values
  ('opt_rep_name',       'Daniel Gomez'),
  ('opt_rep_email',      'daniel@optdigital.io'),
  ('template_retainer',  'EQSiAB3TiYcB4vV2poYJyi'),
  ('template_trial',     ''),
  ('role_opt',           'Role 1'),
  ('role_client',        'Client'),
  ('fee_retainer',       '3000'),
  ('fee_trial',          '997'),
  ('conditions_retainer', 'Term: sold as a three-month package, billed monthly, month to month with no lock-in; the client may cancel from month two with 30 days'' notice. Office leases for any additional profiles are taken in the client''s name and paid by the client. Brand kit and signage for each location are included at no extra cost. No additional fee for additional locations.'),
  ('conditions_trial',   'Two-week paid proof on the main location only. The $997 fee is not refundable and is not a money-back guarantee. The retainer decision is made on the ascension call at the end of the trial.'),
  ('send_subject',       'Your Opt Digital agreement'),
  ('send_message',       'Here is your agreement to review and sign.')
on conflict (key) do nothing;

notify pgrst, 'reload schema';
