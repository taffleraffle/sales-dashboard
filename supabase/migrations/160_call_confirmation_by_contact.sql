-- 160: re-key call confirmation on the PROSPECT and derive attendance from the
-- EOD outcome (Ben 2026-07-16).
--
-- Follow-up to 159. Two surfaces now mark confirmation: the marketing booking
-- drilldown AND the closer's End-of-Day report. They must write ONE shared
-- record, so the key moves from the (deduped) booking id to ghl_contact_id —
-- the prospect — which both surfaces can resolve (booking rows carry it; EOD
-- closer_calls resolve it via ghl_event_id → ghl_appointments).
--
-- Attendance is no longer marked by hand: the EOD already records it as the
-- call outcome (no_show vs closed/not_closed/showed). The rollup view derives
-- showed/no-show from closer_calls, so there's no second place to mark it and
-- nothing to keep in sync. booking_call_status therefore holds only the
-- confirmation mark now.
--
-- 159's table has no rows yet, so this drops and recreates cleanly.

BEGIN;

DROP VIEW  IF EXISTS public.lib_booking_confirmation_daily;
DROP TABLE IF EXISTS public.booking_call_status;

CREATE TABLE public.booking_call_status (
  ghl_contact_id text PRIMARY KEY,
  confirmation   text CHECK (confirmation IN ('confirmed','unconfirmed')),
  marked_by      uuid,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.booking_call_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS booking_call_status_auth ON public.booking_call_status;
CREATE POLICY booking_call_status_auth ON public.booking_call_status
  FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.booking_call_status TO anon, authenticated;

-- Daily rollup for the Confirmed/Unconfirmed Show% tiles. Confirmation comes
-- from the marks; attendance is derived per prospect from their EOD call
-- outcome(s): showed if any call closed/not_closed/showed, no-show if a call
-- no-showed and none showed. A confirmed prospect with no logged call yet
-- counts toward *_calls but not the show/no-show split (no outcome → excluded
-- from the rate), which is correct.
CREATE OR REPLACE VIEW public.lib_booking_confirmation_daily AS
WITH call_attendance AS (
  SELECT a.ghl_contact_id,
         bool_or(cc.outcome IN ('closed','not_closed') OR cc.showed = true) AS showed,
         bool_or(cc.outcome = 'no_show')                                    AS no_show
    FROM closer_calls cc
    JOIN ghl_appointments a ON a.ghl_event_id = cc.ghl_event_id
   WHERE cc.ghl_event_id IS NOT NULL AND cc.ghl_event_id <> ''
   GROUP BY a.ghl_contact_id
)
SELECT
  b.booked_at AS date,
  b.audience,
  count(*) FILTER (WHERE cs.confirmation = 'confirmed')                                                       AS confirmed_calls,
  count(*) FILTER (WHERE cs.confirmation = 'confirmed'   AND ca.showed)                                        AS confirmed_showed,
  count(*) FILTER (WHERE cs.confirmation = 'confirmed'   AND ca.no_show AND NOT COALESCE(ca.showed, false))    AS confirmed_noshow,
  count(*) FILTER (WHERE cs.confirmation = 'unconfirmed')                                                     AS unconfirmed_calls,
  count(*) FILTER (WHERE cs.confirmation = 'unconfirmed' AND ca.showed)                                        AS unconfirmed_showed,
  count(*) FILTER (WHERE cs.confirmation = 'unconfirmed' AND ca.no_show AND NOT COALESCE(ca.showed, false))    AS unconfirmed_noshow
FROM lib_booking_resolved_mv b
JOIN booking_call_status cs ON cs.ghl_contact_id = b.ghl_contact_id
LEFT JOIN call_attendance ca ON ca.ghl_contact_id = b.ghl_contact_id
WHERE NOT b.is_spam
  AND NOT EXISTS (SELECT 1 FROM booking_excluded be WHERE be.booking_id = b.id)
GROUP BY 1, 2;

GRANT SELECT ON public.lib_booking_confirmation_daily TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
