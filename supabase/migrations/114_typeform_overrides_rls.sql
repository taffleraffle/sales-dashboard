-- Lock down typeform_response_overrides (Ben 2026-05-31, code-review pass).
--
-- Migration 113 granted SELECT/INSERT/UPDATE/DELETE to anon for speed, but
-- that means any unauthenticated caller with a response_id (visible in the
-- triage queue HTML) could write, overwrite or wipe overrides. Locking it
-- down to authenticated writers + RLS so auth.uid() owns the row.

BEGIN;

-- Drop anon write grants. Keep SELECT so the page can show current overrides
-- to anyone viewing the dashboard (read-only nav is allowed before login on
-- this app — flip to authenticated-only if that changes).
REVOKE INSERT, UPDATE, DELETE ON public.typeform_response_overrides FROM anon;

-- Server-authoritative set_by_user_id so we don't depend on the client to
-- send it. Falls back to NULL if no JWT is present (e.g. dashboard cron).
ALTER TABLE public.typeform_response_overrides
  ALTER COLUMN set_by_user_id SET DEFAULT auth.uid();

-- Enable RLS and write policies (no SELECT policy because the GRANT already
-- gates read access at the role level — RLS layered on top).
ALTER TABLE public.typeform_response_overrides ENABLE ROW LEVEL SECURITY;

-- Drop+recreate policies so re-running the migration is idempotent.
DROP POLICY IF EXISTS "authenticated can read overrides" ON public.typeform_response_overrides;
DROP POLICY IF EXISTS "authenticated can insert overrides" ON public.typeform_response_overrides;
DROP POLICY IF EXISTS "authenticated can update overrides" ON public.typeform_response_overrides;
DROP POLICY IF EXISTS "authenticated can delete overrides" ON public.typeform_response_overrides;
DROP POLICY IF EXISTS "anon can read overrides" ON public.typeform_response_overrides;

CREATE POLICY "anon can read overrides"
  ON public.typeform_response_overrides
  FOR SELECT TO anon
  USING (true);

CREATE POLICY "authenticated can read overrides"
  ON public.typeform_response_overrides
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "authenticated can insert overrides"
  ON public.typeform_response_overrides
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "authenticated can update overrides"
  ON public.typeform_response_overrides
  FOR UPDATE TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "authenticated can delete overrides"
  ON public.typeform_response_overrides
  FOR DELETE TO authenticated
  USING (auth.uid() IS NOT NULL);

NOTIFY pgrst, 'reload schema';

COMMIT;
