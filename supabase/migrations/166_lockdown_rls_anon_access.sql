-- 166_lockdown_rls_anon_access.sql
-- ---------------------------------------------------------------------------
-- SECURITY FIX: close anonymous (anon / not-logged-in) access to financial,
-- commission, sales-ops and marketing tables.
--
-- BACKGROUND
--   007_commission_tracker.sql created `*_read` / `*_write` policies as
--   `USING (true)` granted to PUBLIC (i.e. the anon role). 019_tighten_rls.sql
--   tried to remove them with `DROP POLICY IF EXISTS "Allow all"` — but the real
--   policy names are `payments_read`, `payments_write`, `clients_read`, etc., so
--   those DROPs were no-ops and the permissive policies SURVIVED. Postgres
--   OR-combines permissive policies, so the surviving `USING(true)` policies keep
--   anon fully enabled. `clients` and `commission_settings` were never touched by
--   019 at all. 009_client_billing.sql additionally did
--   `GRANT ALL ON clients, payments TO anon`.
--   Net effect (confirmed): anyone with the public anon key (it ships in the
--   browser bundle) can, WITHOUT LOGGING IN, read all revenue/commission/PII and
--   write commission_ledger / payments to inflate payouts or fabricate revenue.
--
-- WHAT THIS DOES
--   For every listed table: enable RLS, drop ALL existing policies (by any name,
--   so the survivors from 007 are actually removed), then recreate a clean set
--   scoped to `authenticated` + `service_role` ONLY. Anon is dropped everywhere.
--   Direct anon table GRANTs (from 009) are revoked; authenticated/service_role
--   grants are (re)asserted so the logged-in dashboard keeps working.
--
-- WHY authenticated CAN STILL WRITE (deliberate)
--   The dashboard writes payments / commission_ledger / commission_settings /
--   clients DIRECTLY from the browser as the logged-in (authenticated) user
--   (manual payment entry, commission generation, client CRUD, settings upsert —
--   see src/pages/CommissionPage.jsx, src/hooks/useCommissions.js,
--   src/components/commission/*). Locking writes to service_role only would break
--   those flows. This migration therefore closes the CRITICAL hole (anonymous,
--   no-login access) without breaking any logged-in workflow.
--
-- RESIDUAL (NOT fixed here — needs an app change, not SQL)
--   A logged-in staff member can still write these tables (that is how the app is
--   built). To remove that insider vector, move the financial writes into Edge
--   Functions with a role check and lock browser writes to service_role. Tracked
--   separately — do NOT attempt it in a migration or the dashboard breaks.
--
-- SAFE TO RE-RUN: idempotent (drops-then-recreates; existence-guarded per table).
-- Preview first with:  migrate.py --project <sales> --file <this> --dry-run
-- ---------------------------------------------------------------------------

DO $do$
DECLARE
  t             text;
  pol           text;
  authsvc       text := $pred$auth.role() IN ('authenticated', 'service_role')$pred$;
  target_tables text[] := ARRAY[
    -- financial / commission (browser writes these as authenticated)
    'payments', 'commission_ledger', 'commission_settings', 'clients',
    -- sales-ops / PII (legacy 001 "Allow all" survivors)
    'closer_eod_reports', 'closer_calls', 'setter_eod_reports', 'setter_leads',
    'closer_transcripts', 'objection_analysis', 'wavv_calls',
    -- marketing
    'marketing_tracker', 'marketing_benchmarks'
  ];
BEGIN
  FOREACH t IN ARRAY target_tables LOOP
    -- Skip anything not present in this DB rather than failing the whole run.
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'lockdown: skipping missing table %', t;
      CONTINUE;
    END IF;

    -- 1) A table with RLS DISABLED ignores policies entirely — force it on.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- 2) Drop EVERY existing policy on the table, whatever it is named. This is
    --    what actually removes the surviving 007 `USING(true)` policies that 019
    --    failed to drop.
    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, t);
    END LOOP;

    -- 3) Clean policy set: authenticated + service_role only. No anon.
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (%s)',
                   t || '_sel_authsvc', t, authsvc);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (%s)',
                   t || '_ins_authsvc', t, authsvc);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (%s) WITH CHECK (%s)',
                   t || '_upd_authsvc', t, authsvc, authsvc);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (%s)',
                   t || '_del_authsvc', t, authsvc);

    -- 4) Privilege hygiene: revoke the anon GRANTs (009 gave anon ALL on
    --    clients/payments) and (re)assert the grants the dashboard relies on.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated, service_role', t);
  END LOOP;
END
$do$;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- POST-CHECK (optional): run this SELECT afterwards — every row should show the
-- new *_authsvc policies and NO policy with qual = 'true'. Any remaining
-- `true` qual means a permissive policy escaped the drop.
--   SELECT tablename, policyname, cmd, qual
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('payments','commission_ledger','commission_settings',
--                       'clients','closer_transcripts','wavv_calls')
--   ORDER BY tablename, cmd;
-- ---------------------------------------------------------------------------
