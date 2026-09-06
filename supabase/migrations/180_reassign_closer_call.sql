-- 180: move a call to the closer who actually took it (Ben, 6 Sep 2026)
--
-- "A function on EOD to change the closer that took the call, in case it's
--  needed or they had to reschedule it."
--
-- A call belongs to a closer only through the end of day report it sits on, so
-- moving it means moving it onto the right closer's report for the same day.
-- If that closer has no report for that day one is created, and created
-- CONFIRMED on purpose: every metric on the dashboard counts calls on confirmed
-- reports only, so an unconfirmed target would make the call silently vanish
-- from the show rate, the close rate and the totals.
--
-- Nothing is duplicated and nothing is deleted. The call keeps its outcome,
-- revenue, cash and notes; only which closer it hangs off changes.

CREATE OR REPLACE FUNCTION public.reassign_closer_call(
  p_call_id      uuid,
  p_to_closer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller     uuid := auth.uid();
  v_role       text;
  v_call       public.closer_calls%ROWTYPE;
  v_from_id    uuid;
  v_date       date;
  v_from_name  text;
  v_to_name    text;
  v_to_report  uuid;
  v_created    boolean := false;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  SELECT role INTO v_role FROM public.user_profiles WHERE auth_user_id = v_caller;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'Only an admin or manager can move a call to another closer';
  END IF;

  SELECT * INTO v_call FROM public.closer_calls WHERE id = p_call_id;
  IF v_call.id IS NULL THEN
    RAISE EXCEPTION 'No such call';
  END IF;

  SELECT r.closer_id, r.report_date INTO v_from_id, v_date
    FROM public.closer_eod_reports r WHERE r.id = v_call.eod_report_id;
  IF v_date IS NULL THEN
    RAISE EXCEPTION 'That call is not attached to an end of day report';
  END IF;

  SELECT name INTO v_to_name FROM public.team_members WHERE id = p_to_closer_id;
  IF v_to_name IS NULL THEN
    RAISE EXCEPTION 'No such closer';
  END IF;
  SELECT name INTO v_from_name FROM public.team_members WHERE id = v_from_id;

  IF v_from_id = p_to_closer_id THEN
    RETURN jsonb_build_object('ok', true, 'moved', false,
      'reason', format('That call is already on %s''s report.', v_to_name));
  END IF;

  SELECT id INTO v_to_report
    FROM public.closer_eod_reports
   WHERE closer_id = p_to_closer_id AND report_date = v_date
   LIMIT 1;

  IF v_to_report IS NULL THEN
    INSERT INTO public.closer_eod_reports (closer_id, report_date, is_confirmed, notes)
    VALUES (p_to_closer_id, v_date, true,
            format('Created automatically on %s when a call was moved here from %s.',
                   to_char(now() AT TIME ZONE 'America/New_York', 'DD Mon YYYY'),
                   coalesce(v_from_name, 'another closer')))
    RETURNING id INTO v_to_report;
    v_created := true;
  ELSE
    -- The call only counts if the report it lands on is confirmed
    UPDATE public.closer_eod_reports SET is_confirmed = true, updated_at = now()
     WHERE id = v_to_report AND is_confirmed IS NOT true;
  END IF;

  UPDATE public.closer_calls SET eod_report_id = v_to_report WHERE id = p_call_id;

  -- The booking side should agree with the call, so the Team totals and the
  -- per-closer booked counts do not drift apart.
  IF v_call.ghl_event_id IS NOT NULL AND v_call.ghl_event_id <> '' THEN
    UPDATE public.ghl_appointments SET closer_id = p_to_closer_id
     WHERE ghl_event_id = v_call.ghl_event_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'moved', true,
    'prospect', v_call.prospect_name,
    'report_date', v_date,
    'from', coalesce(v_from_name, 'unassigned'),
    'to', v_to_name,
    'created_report', v_created
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reassign_closer_call(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reassign_closer_call(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.reassign_closer_call(uuid, uuid) IS
  'Move a logged call onto another closer''s end of day report for the same date, creating that report confirmed if it does not exist, and re-point the booking. Admin or manager only.';
