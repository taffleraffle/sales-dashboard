-- 037_typeform_response_detail.sql
-- Per-prospect detail view backing the click-to-drill-down popup on the
-- Ads Performance table. Joins typeform_responses to the outcome
-- view so the React modal can render the actual people behind every
-- "Booked / Qual Booked / Live / Closes" count in the rollup.
--
-- Filter columns on the React side:
--   ad_id        eq <ad_id>          → drill into one specific ad
--   adset_id     eq <adset_id>       → drill into one ad set
--   utm_campaign eq <campaign name>  → drill into campaign rollup
--
-- And then any of:
--   is_booked    = true   for "Booked"  cell
--   is_booked + qualified for "Qual Booked"
--   is_live      = true   for "Live"
--   is_closed    = true   for "Closes"
--   qualified    = true   for "Qual Leads"
--   (no filter)           for "Leads"
--
-- Idempotent. Apply via supabase db push.

BEGIN;

DROP VIEW IF EXISTS public.lib_typeform_response_detail CASCADE;
CREATE VIEW public.lib_typeform_response_detail AS
SELECT
  tfr.response_id,
  tfr.submitted_at,
  tfr.first_name,
  tfr.last_name,
  COALESCE(NULLIF(trim(concat_ws(' ', tfr.first_name, tfr.last_name)), ''),
           tfr.email,
           tfr.response_id)                            AS display_name,
  tfr.email,
  tfr.phone,
  tfr.revenue_tier,
  tfr.tier,
  tfr.qualified,
  tfr.utm_campaign,
  tfr.utm_term                                          AS adset_id,
  tfr.ad_id,
  o.matched_event_id,
  (o.matched_event_id IS NOT NULL)                      AS is_booked,
  COALESCE(
    o.appt_outcome IN ('showed','closed','not_closed')
    OR o.cc_showed = TRUE
    OR o.cc_outcome IN ('showed','closed','not_closed'),
    FALSE
  )                                                     AS is_live,
  COALESCE(
    o.appt_outcome = 'closed' OR o.cc_outcome = 'closed',
    FALSE
  )                                                     AS is_closed,
  GREATEST(COALESCE(o.appt_revenue,0), COALESCE(o.cc_revenue,0)) AS revenue,
  GREATEST(COALESCE(o.appt_cash,0),    COALESCE(o.cc_cash,0))    AS cash_collected,
  o.appt_outcome,
  o.cc_outcome,
  o.cc_showed
FROM public.typeform_responses tfr
LEFT JOIN public.lib_typeform_response_outcome o ON o.response_id = tfr.response_id;

GRANT SELECT ON public.lib_typeform_response_detail TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
