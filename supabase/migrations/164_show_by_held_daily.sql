-- 164: honest Show Rate — held-call cohort (Ben audit, 2026-07-20).
--
-- The old Gross Show% divided live_calls (bucketed by CALL day) by
-- qualified_bookings (bucketed by BOOKED day). In any window those are
-- DIFFERENT cohorts: shows in the window can come from bookings made before
-- it, so lives/booked routinely exceeded 100% and the frontend hid it with
-- Math.min(100). Net Show% (lives / (lives + no_shows)) was cohort-consistent
-- but the gross tile, the drilldown and Closer Overview each computed the
-- rate differently, so the dashboard reported up to 4 different show rates.
--
-- This view is the single honest source: anchor BOTH numerator and
-- denominator to the day the call was HELD (appointment_date). A call is
-- "held in the window" if its appointment_date falls in the window; it
-- "showed" if the closer logged showed=true for that event. Show rate is then
-- showed / held (gross) or showed / (showed + no_show) (net, logged outcomes
-- only). Both are ≤100% by construction — no cap needed.
--
-- Only qualified, non-spam, non-cancelled strategy bookings count (same
-- population as the qualified-bookings tile). closer_calls joins directly on
-- ghl_event_id (the appointment key the closer's EOD row carries).

CREATE OR REPLACE VIEW public.lib_show_by_held_daily AS
WITH held AS (
  SELECT
    r.ghl_event_id,
    r.audience,
    r.appointment_date AS day
  FROM public.lib_strategy_booking_resolved r
  WHERE r.appointment_date IS NOT NULL
    AND r.appointment_status <> 'cancelled'
    AND NOT r.is_dq
    AND NOT r.is_spam
),
outcome AS (
  SELECT
    cc.ghl_event_id,
    bool_or(cc.showed IS TRUE)  AS showed,
    bool_or(cc.showed IS FALSE) AS no_show
  FROM public.closer_calls cc
  WHERE cc.ghl_event_id IS NOT NULL
  GROUP BY cc.ghl_event_id
)
SELECT
  h.day,
  h.audience,
  count(*)                                                   AS held,
  count(*) FILTER (WHERE o.showed IS TRUE)                   AS showed,
  count(*) FILTER (WHERE o.showed IS NOT TRUE
                    AND o.no_show IS TRUE)                   AS no_show,
  count(*) FILTER (WHERE o.ghl_event_id IS NULL)             AS no_outcome
FROM held h
LEFT JOIN outcome o ON o.ghl_event_id = h.ghl_event_id
GROUP BY h.day, h.audience;

GRANT SELECT ON public.lib_show_by_held_daily TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
