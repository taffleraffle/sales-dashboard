-- 179: the offboard action itself (Ben, 6 Sep 2026)
--
-- One call does the whole thing, so offboarding can never be half done:
--   * bans their login, so they cannot sign in again
--   * kills every session they have open right now, so they are out immediately
--   * marks them as former on the roster, with the date and the reason
--   * leaves every row of their history exactly where it is
--
-- Written as a SECURITY DEFINER function rather than an edge function because
-- it has to reach the auth schema, which the dashboard's anon key cannot. The
-- admin check is inside, keyed on the caller's own token, so it cannot be
-- called by anyone else even though it is exposed over the API.
--
-- Reversible: pass p_undo => true to reinstate someone offboarded by mistake.

CREATE OR REPLACE FUNCTION public.offboard_team_member(
  p_member_id uuid,
  p_reason    text DEFAULT NULL,
  p_undo      boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
DECLARE
  v_caller     uuid := auth.uid();
  v_role       text;
  v_member     public.team_members%ROWTYPE;
  v_sessions   integer := 0;
  v_future     integer := 0;
  v_unconfirmed integer := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE auth_user_id = v_caller;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'Only an admin or manager can offboard someone';
  END IF;

  SELECT * INTO v_member FROM public.team_members WHERE id = p_member_id;
  IF v_member.id IS NULL THEN
    RAISE EXCEPTION 'No such team member';
  END IF;

  IF p_undo THEN
    UPDATE public.team_members
       SET is_active = true, offboarded_at = NULL, offboard_reason = NULL, offboarded_by = NULL
     WHERE id = p_member_id;

    IF v_member.auth_user_id IS NOT NULL THEN
      UPDATE auth.users SET banned_until = NULL WHERE id = v_member.auth_user_id;
    END IF;

    RETURN jsonb_build_object('ok', true, 'action', 'reinstated', 'name', v_member.name);
  END IF;

  -- Work that would otherwise be stranded, reported back so it can be handed over
  SELECT count(*) INTO v_future
    FROM public.ghl_appointments
   WHERE closer_id = p_member_id AND appointment_date >= (now() AT TIME ZONE 'America/New_York')::date;

  SELECT count(*) INTO v_unconfirmed
    FROM public.closer_eod_reports
   WHERE closer_id = p_member_id AND is_confirmed IS NOT true;

  UPDATE public.team_members
     SET offboarded_at   = now(),
         offboarded_by   = v_caller,
         offboard_reason = NULLIF(btrim(coalesce(p_reason, '')), ''),
         is_active       = false
   WHERE id = p_member_id;

  IF v_member.auth_user_id IS NOT NULL THEN
    -- Block any future sign-in. Banning rather than deleting keeps every
    -- foreign key, and so every EOD and call they ever logged.
    UPDATE auth.users
       SET banned_until = now() + interval '100 years'
     WHERE id = v_member.auth_user_id;

    -- Sign them out of anything open right now
    SELECT count(*) INTO v_sessions FROM auth.sessions WHERE user_id = v_member.auth_user_id;
    DELETE FROM auth.refresh_tokens WHERE user_id = v_member.auth_user_id::text;
    DELETE FROM auth.sessions WHERE user_id = v_member.auth_user_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'offboarded',
    'name', v_member.name,
    'role', v_member.role,
    'login_blocked', v_member.auth_user_id IS NOT NULL,
    'sessions_ended', v_sessions,
    'future_appointments', v_future,
    'unconfirmed_eods', v_unconfirmed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.offboard_team_member(uuid, text, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.offboard_team_member(uuid, text, boolean) TO authenticated;

COMMENT ON FUNCTION public.offboard_team_member(uuid, text, boolean) IS
  'Offboard a team member: ban their login, end their sessions, mark them former. Keeps all history. p_undo reinstates. Admin or manager only.';
