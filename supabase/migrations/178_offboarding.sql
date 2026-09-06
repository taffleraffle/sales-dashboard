-- 178: offboarding a closer or setter (Ben, 6 Sep 2026)
--
-- "Mark someone as offboarded and close their ability to take anything anymore.
--  I need to keep their data. Daniel's no longer with us."
--
-- Offboarding is deliberately NOT a delete and NOT the same as the old
-- Deactivate. It records that the person has left, on a date, with a reason,
-- so the dashboard can do two different things with one fact:
--   forward looking  -> they are gone: no rotations, no EOD chasing, no new work
--   backward looking -> they are still there: 235 EODs and 565 calls of history
--
-- The access side (blocking their login) is done by the offboard-team-member
-- edge function, which bans their auth user and kills their sessions. That
-- cannot be done from SQL with the anon key, and banning rather than deleting
-- is what keeps every foreign key and every row of their history intact.

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS offboarded_at   timestamptz,
  ADD COLUMN IF NOT EXISTS offboarded_by   uuid,
  ADD COLUMN IF NOT EXISTS offboard_reason text;

COMMENT ON COLUMN public.team_members.offboarded_at IS
  'When they left. NULL means they are still with us. Set by the offboard-team-member function, which also bans their login. Their history is never deleted.';

-- Anyone offboarded is inactive by definition; the reverse is not true
-- (inactive can just mean paused).
CREATE OR REPLACE FUNCTION public.team_member_offboard_sync()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.offboarded_at IS NOT NULL THEN
    NEW.is_active := false;
  END IF;
  -- Reinstating someone clears the leaving date so they behave like a normal
  -- active member again.
  IF NEW.is_active AND NEW.offboarded_at IS NOT NULL AND OLD.is_active IS DISTINCT FROM true THEN
    NEW.offboarded_at := NULL;
    NEW.offboard_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS team_member_offboard_sync_trg ON public.team_members;
CREATE TRIGGER team_member_offboard_sync_trg
  BEFORE UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.team_member_offboard_sync();

-- Everyone who has ever been on the team, with their status spelled out, so a
-- page can ask for history without having to know the is_active rules.
CREATE OR REPLACE VIEW public.lib_team_members_all AS
 SELECT t.*,
    CASE
      WHEN t.offboarded_at IS NOT NULL THEN 'former'::text
      WHEN t.is_active IS FALSE THEN 'paused'::text
      ELSE 'active'::text
    END AS status
   FROM public.team_members t;

GRANT SELECT ON public.lib_team_members_all TO anon, authenticated, service_role;
