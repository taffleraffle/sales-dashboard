-- 161: per-closer confirmed-vs-unconfirmed show rate for the Closer Overview
-- (Ben 2026-07-16).
--
-- Same confirmation mark (booking_call_status, keyed on the prospect) but sliced
-- by the closer who took the call, so the overview can show each closer's show
-- rate on confirmed vs unconfirmed calls. Attendance is the specific call's
-- outcome (closed/not_closed/showed = showed, no_show = no-show), joined to the
-- confirmation via the call's ghl_event_id → ghl_appointments → contact.

CREATE OR REPLACE VIEW public.lib_call_confirmation_by_closer AS
SELECT
  r.closer_id,
  r.report_date,
  count(*) FILTER (WHERE cs.confirmation = 'confirmed')                                                                        AS confirmed_calls,
  count(*) FILTER (WHERE cs.confirmation = 'confirmed'   AND (cc.outcome IN ('closed','not_closed') OR cc.showed = true))       AS confirmed_showed,
  count(*) FILTER (WHERE cs.confirmation = 'confirmed'   AND cc.outcome = 'no_show')                                            AS confirmed_noshow,
  count(*) FILTER (WHERE cs.confirmation = 'unconfirmed')                                                                      AS unconfirmed_calls,
  count(*) FILTER (WHERE cs.confirmation = 'unconfirmed' AND (cc.outcome IN ('closed','not_closed') OR cc.showed = true))       AS unconfirmed_showed,
  count(*) FILTER (WHERE cs.confirmation = 'unconfirmed' AND cc.outcome = 'no_show')                                            AS unconfirmed_noshow
FROM closer_calls cc
JOIN closer_eod_reports r ON r.id = cc.eod_report_id
JOIN ghl_appointments a   ON a.ghl_event_id = cc.ghl_event_id
JOIN booking_call_status cs ON cs.ghl_contact_id = a.ghl_contact_id
WHERE cc.ghl_event_id IS NOT NULL AND cc.ghl_event_id <> ''
GROUP BY r.closer_id, r.report_date;

GRANT SELECT ON public.lib_call_confirmation_by_closer TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
