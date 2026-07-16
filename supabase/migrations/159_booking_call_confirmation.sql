-- 159: per-booking call confirmation + attendance marking (Ben 2026-07-16).
--
-- Ben wants to track show rate separately for CONFIRMED vs UNCONFIRMED calls
-- ("good on confirmed, bad on unconfirmed — the guys are just auto-booked").
-- There's no reliable confirmation signal in the data (GHL appointment_status
-- is the uniform 'confirmed' default; outcome is 99% null), and per-booking
-- show/no-show isn't tracked either. Both are marked manually in the bookings
-- drilldown (the team already colour-codes the Google Calendar red/green).
--
-- booking_call_status: one row per booking the operator has touched. Both
-- columns are nullable — a booking with no row is "unset" and doesn't count
-- in either cohort. Keyed on the resolved booking id (lib_booking_resolved_mv
-- .id = ghl_appointments.id), same key as booking_excluded. Mirrors that
-- table's RLS-permissive + anon/authenticated grant pattern so the dashboard
-- (anon key) can read/write it.

BEGIN;

CREATE TABLE IF NOT EXISTS public.booking_call_status (
  booking_id   uuid PRIMARY KEY,
  confirmation text CHECK (confirmation IN ('confirmed','unconfirmed')),
  attendance   text CHECK (attendance IN ('showed','no_show')),
  marked_by    uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.booking_call_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS booking_call_status_auth ON public.booking_call_status;
CREATE POLICY booking_call_status_auth ON public.booking_call_status
  FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.booking_call_status TO anon, authenticated;

-- Daily rollup by audience for the Confirmed/Unconfirmed Show% tiles. Only
-- marked bookings appear (INNER JOIN). Excludes spam + any booking_excluded
-- row so the cohorts line up with the qualified-booking counts. Show% is
-- computed on the read side as showed / (showed + no_show).
CREATE OR REPLACE VIEW public.lib_booking_confirmation_daily AS
SELECT
  b.booked_at AS date,
  b.audience,
  count(*) FILTER (WHERE cs.confirmation = 'confirmed')                               AS confirmed_calls,
  count(*) FILTER (WHERE cs.confirmation = 'confirmed'   AND cs.attendance = 'showed')  AS confirmed_showed,
  count(*) FILTER (WHERE cs.confirmation = 'confirmed'   AND cs.attendance = 'no_show') AS confirmed_noshow,
  count(*) FILTER (WHERE cs.confirmation = 'unconfirmed')                             AS unconfirmed_calls,
  count(*) FILTER (WHERE cs.confirmation = 'unconfirmed' AND cs.attendance = 'showed')  AS unconfirmed_showed,
  count(*) FILTER (WHERE cs.confirmation = 'unconfirmed' AND cs.attendance = 'no_show') AS unconfirmed_noshow
FROM lib_booking_resolved_mv b
JOIN booking_call_status cs ON cs.booking_id = b.id
WHERE NOT b.is_spam
  AND NOT EXISTS (SELECT 1 FROM booking_excluded be WHERE be.booking_id = b.id)
GROUP BY 1, 2;

GRANT SELECT ON public.lib_booking_confirmation_daily TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
