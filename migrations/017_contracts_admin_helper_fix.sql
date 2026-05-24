-- 017_contracts_admin_helper_fix.sql
-- Fixes the RLS bug Ben hit when trying to save his first amendment review:
--   "new row violates row-level security policy for table contracts"
--
-- Root cause: contracts_is_admin() (introduced in 015) only checks
-- public.team_members.role = 'admin'. Ben's admin role actually lives in
-- public.user_profiles.role (set in migration 007). The team_members table
-- holds closers/setters with roles like 'closer','setter'. So when Ben
-- inserted a contract:
--   - contracts_is_admin() returned FALSE (he isn't in team_members as admin)
--   - closer_id was null (admins don't have a team_member_id by default)
--   - WITH CHECK denied the insert
--
-- Fix: contracts_is_admin() now also returns true for any auth user whose
-- user_profiles.role is 'admin' or 'manager'. This matches the dashboard's
-- existing isAdmin check in AuthContext.jsx:
--   isAdmin = profile.appRole === 'admin' || profile.appRole === 'manager'

CREATE OR REPLACE FUNCTION public.contracts_is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members
    WHERE auth_user_id = auth.uid()
      AND role = 'admin'
  )
  OR EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE auth_user_id = auth.uid()
      AND role IN ('admin','manager')
  );
$$;

NOTIFY pgrst, 'reload schema';
