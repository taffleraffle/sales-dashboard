-- 038_typeform_booked_includes_closer_calls.sql
-- Bug fix: Live calls > Booked calls on the perf dashboard. Caused by
-- treating "booked" as "has a row in ghl_appointments matched on email/phone"
-- while "live" ALSO accepted name-only matches against closer_calls.
-- A prospect with a typeform email that doesn't match their GHL contact
-- (because they booked under a different inbox — happens often for our
-- restoration ops where the listed business email != personal email used
-- on the typeform) wound up Live=1 / Booked=0 / cost-per-live < cost-per-book.
--
-- Fix: every match path that proves they showed up to a call also proves
-- they booked one. Redefine is_booked as the UNION of (GHL appt match) +
-- (closer_calls match). The rollup views and the detail view both pick
-- up the new definition.
--
-- Funnel invariant after this migration:
--   leads ≥ qualified_leads
--   leads ≥ booked_calls ≥ live_calls ≥ closes
--   qualified_booked_calls ≤ booked_calls
--   qualified_booked_calls ≤ qualified_leads
--
-- Idempotent. Apply via supabase db push.

BEGIN;

-- ─── lib_typeform_ad_attribution ────────────────────────────────────
DROP VIEW IF EXISTS public.lib_typeform_ad_attribution CASCADE;
CREATE VIEW public.lib_typeform_ad_attribution AS
SELECT
  ad_id,
  count(*)                                                                                              AS leads,
  count(*) FILTER (WHERE qualified)                                                                     AS qualified_leads,
  count(*) FILTER (WHERE
       matched_event_id IS NOT NULL
    OR cc_showed = TRUE
    OR cc_outcome IS NOT NULL
  )                                                                                                     AS booked_calls,
  count(*) FILTER (WHERE qualified AND (
       matched_event_id IS NOT NULL
    OR cc_showed = TRUE
    OR cc_outcome IS NOT NULL
  ))                                                                                                    AS qualified_booked_calls,
  count(*) FILTER (WHERE
       appt_outcome IN ('showed','closed','not_closed')
    OR cc_showed = TRUE
    OR cc_outcome IN ('showed','closed','not_closed')
  )                                                                                                     AS live_calls,
  count(*) FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed')                              AS closes,
  COALESCE(sum(GREATEST(appt_revenue, cc_revenue, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)                                 AS revenue_attributed,
  COALESCE(sum(GREATEST(appt_cash, cc_cash, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)                                 AS cash_attributed
FROM public.lib_typeform_response_outcome
WHERE ad_id IS NOT NULL
GROUP BY ad_id;

GRANT SELECT ON public.lib_typeform_ad_attribution TO anon, authenticated;

-- ─── lib_typeform_adset_attribution ─────────────────────────────────
DROP VIEW IF EXISTS public.lib_typeform_adset_attribution CASCADE;
CREATE VIEW public.lib_typeform_adset_attribution AS
SELECT
  adset_id,
  count(*)                                                                                              AS leads,
  count(*) FILTER (WHERE qualified)                                                                     AS qualified_leads,
  count(*) FILTER (WHERE
       matched_event_id IS NOT NULL
    OR cc_showed = TRUE
    OR cc_outcome IS NOT NULL
  )                                                                                                     AS booked_calls,
  count(*) FILTER (WHERE qualified AND (
       matched_event_id IS NOT NULL
    OR cc_showed = TRUE
    OR cc_outcome IS NOT NULL
  ))                                                                                                    AS qualified_booked_calls,
  count(*) FILTER (WHERE
       appt_outcome IN ('showed','closed','not_closed')
    OR cc_showed = TRUE
    OR cc_outcome IN ('showed','closed','not_closed')
  )                                                                                                     AS live_calls,
  count(*) FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed')                              AS closes,
  COALESCE(sum(GREATEST(appt_revenue, cc_revenue, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)                                 AS revenue_attributed,
  COALESCE(sum(GREATEST(appt_cash, cc_cash, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)                                 AS cash_attributed
FROM public.lib_typeform_response_outcome
WHERE adset_id IS NOT NULL
GROUP BY adset_id;

GRANT SELECT ON public.lib_typeform_adset_attribution TO anon, authenticated;

-- ─── lib_typeform_campaign_attribution ──────────────────────────────
DROP VIEW IF EXISTS public.lib_typeform_campaign_attribution CASCADE;
CREATE VIEW public.lib_typeform_campaign_attribution AS
SELECT
  utm_campaign,
  count(*)                                                                                              AS leads,
  count(*) FILTER (WHERE qualified)                                                                     AS qualified_leads,
  count(*) FILTER (WHERE
       matched_event_id IS NOT NULL
    OR cc_showed = TRUE
    OR cc_outcome IS NOT NULL
  )                                                                                                     AS booked_calls,
  count(*) FILTER (WHERE qualified AND (
       matched_event_id IS NOT NULL
    OR cc_showed = TRUE
    OR cc_outcome IS NOT NULL
  ))                                                                                                    AS qualified_booked_calls,
  count(*) FILTER (WHERE
       appt_outcome IN ('showed','closed','not_closed')
    OR cc_showed = TRUE
    OR cc_outcome IN ('showed','closed','not_closed')
  )                                                                                                     AS live_calls,
  count(*) FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed')                              AS closes,
  COALESCE(sum(GREATEST(appt_revenue, cc_revenue, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)                                 AS revenue_attributed,
  COALESCE(sum(GREATEST(appt_cash, cc_cash, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)                                 AS cash_attributed
FROM public.lib_typeform_response_outcome
WHERE utm_campaign IS NOT NULL
GROUP BY utm_campaign;

GRANT SELECT ON public.lib_typeform_campaign_attribution TO anon, authenticated;

-- ─── lib_typeform_response_detail (for the drill-down modal) ────────
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
  -- is_booked now also accepts closer_calls evidence — same rule as the rollup views.
  COALESCE(
        o.matched_event_id IS NOT NULL
     OR o.cc_showed = TRUE
     OR o.cc_outcome IS NOT NULL,
    FALSE
  )                                                     AS is_booked,
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
