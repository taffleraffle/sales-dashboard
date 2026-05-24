-- 022_contract_policy_admin_only_read.sql
-- Tightens contract_policy SELECT from "any authenticated user" to
-- "admin only." The original 015 policy was wide-open SELECT on the
-- assumption that the AI judge function needed to read it as the
-- caller — but Edge functions use service_role and bypass RLS
-- entirely, so the wide-open read was only ever needed for the admin
-- policy editor page (which gates itself in the UI).
--
-- Why this matters NOW: migration 021 introduced a 'downsell' kind on
-- contract_policy whose text will contain internal unit economics
-- (per-line COGS, gross margin targets, finance fee structure). That
-- data must not leak to non-admin closers, who can poke the API even
-- if the UI hides it.
--
-- After this migration:
--   - Closers can no longer SELECT from contract_policy via PostgREST
--   - The amendment judge + downsell coach Edge functions continue to
--     read it because they use service_role (RLS-bypass)
--   - The admin-only Policy editor page continues to work because the
--     admin's auth.uid() passes contracts_is_admin()
--
-- Safe to run multiple times.

DROP POLICY IF EXISTS contract_policy_read ON public.contract_policy;
CREATE POLICY contract_policy_read ON public.contract_policy
  FOR SELECT TO authenticated
  USING (public.contracts_is_admin());

-- contract_policy_write was already admin-only; restating defensively
-- in case a hand-edit drifted it. No-op when already correct.
DROP POLICY IF EXISTS contract_policy_write ON public.contract_policy;
CREATE POLICY contract_policy_write ON public.contract_policy
  FOR ALL TO authenticated
  USING (public.contracts_is_admin())
  WITH CHECK (public.contracts_is_admin());

NOTIFY pgrst, 'reload schema';
