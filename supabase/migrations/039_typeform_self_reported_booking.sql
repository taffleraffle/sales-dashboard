-- 039_typeform_self_reported_booking.sql
-- Source-of-truth for "did this lead book": the typeform thank-you
-- screen they landed on. The OPT funnel ends at one of these screens:
--
--   "30k+ Booking Confirmation"   — completed the booking flow
--   ">30k Booking DQ"             — saw a booking page but was DQ'd post-
--                                   reaching it (likely sub-30k didn't
--                                   agree to pricing). Not a confirmed booking.
--   "DQ Page"                     — disqualified up front
--   "All done! Thanks for your time." — default fallthrough
--
-- Until now we relied on (a) email/phone match against ghl_appointments
-- and (b) name match against closer_calls. Both lag the actual booking by
-- hours or days, AND fail when the prospect uses different identifiers
-- than the typeform. Result: leads that demonstrably booked (Mark Kowal,
-- Shane Dodson on OPT-VID-TEST 1, May 10–11) showed Booked=0 on the
-- dashboard because the closer hadn't filed an EOD yet and the GHL email
-- happened to differ.
--
-- Add the typeform's own booking signal as a third evidence path. This is
-- the strongest of the three because it's recorded the moment the
-- prospect completes the form, no downstream sync required.
--
-- The Typeform sync now resolves thank-you screen ref → title at sync
-- time (see sync-typeform/index.ts). Existing rows that pre-date this
-- change will still have UUID refs in ending_screen and will get
-- back-filled on the next sync run. For belt-and-braces, this migration
-- accepts both: the known "30k+ Booking Confirmation" title AND the
-- canonical UUID 3a2ea433-3125-4b59-831e-27676b982d35 that backs it.
--
-- Idempotent. Apply via supabase db push.

BEGIN;

-- Helper expression used everywhere downstream. A response counts as
-- "self-reported booked" if the thank-you screen is the booking
-- confirmation page (either as readable title or as its UUID ref).
CREATE OR REPLACE FUNCTION public.tfr_self_reported_booked(ending_screen TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$
  SELECT COALESCE(
    ending_screen ILIKE '%booking confirmation%'
    OR ending_screen = '3a2ea433-3125-4b59-831e-27676b982d35',
    FALSE
  )
$$;

-- ─── lib_typeform_response_outcome ──────────────────────────────────
-- Re-expose ending_screen so downstream views can see the typeform
-- booking signal without re-joining typeform_responses.
DROP VIEW IF EXISTS public.lib_typeform_response_outcome CASCADE;
CREATE VIEW public.lib_typeform_response_outcome AS
SELECT
  tfr.response_id,
  tfr.ad_id,
  tfr.utm_term       AS adset_id,
  tfr.utm_campaign,
  tfr.qualified,
  tfr.ending_screen,
  public.tfr_self_reported_booked(tfr.ending_screen) AS tf_booked,
  appt.ghl_event_id           AS matched_event_id,
  appt.outcome                AS appt_outcome,
  appt.revenue                AS appt_revenue,
  appt.cash_collected         AS appt_cash,
  cc.showed                   AS cc_showed,
  cc.outcome                  AS cc_outcome,
  cc.revenue                  AS cc_revenue,
  cc.cash_collected           AS cc_cash
FROM public.typeform_responses tfr
LEFT JOIN LATERAL (
  SELECT a.*
  FROM public.ghl_appointments a
  WHERE
        (tfr.email IS NOT NULL AND lower(a.contact_email) = lower(tfr.email))
     OR (public.digits_only(tfr.phone) IS NOT NULL
         AND public.digits_only(a.contact_phone) IS NOT NULL
         AND right(public.digits_only(tfr.phone), 10) = right(public.digits_only(a.contact_phone), 10))
  ORDER BY a.booked_at DESC NULLS LAST
  LIMIT 1
) appt ON true
LEFT JOIN LATERAL (
  SELECT c.*
  FROM public.closer_calls c
  WHERE tfr.first_name IS NOT NULL
    AND length(tfr.first_name) >= 2
    AND c.prospect_name ILIKE (tfr.first_name || '%')
    AND (
      tfr.last_name IS NULL
      OR length(tfr.last_name) < 2
      OR c.prospect_name ILIKE ('%' || tfr.last_name || '%')
    )
  ORDER BY c.created_at DESC
  LIMIT 1
) cc ON true;

GRANT SELECT ON public.lib_typeform_response_outcome TO anon, authenticated;

-- ─── Rollup views ────────────────────────────────────────────────────
-- booked_calls now = (GHL appt match) OR (closer_calls match) OR
-- (typeform self-reported booking confirmation). Same rule applies to
-- qualified_booked_calls. Live and Closes are unchanged — those still
-- require evidence the call actually happened.

DROP VIEW IF EXISTS public.lib_typeform_ad_attribution CASCADE;
CREATE VIEW public.lib_typeform_ad_attribution AS
SELECT
  ad_id,
  count(*)                                                                 AS leads,
  count(*) FILTER (WHERE qualified)                                        AS qualified_leads,
  count(*) FILTER (WHERE
       matched_event_id IS NOT NULL
    OR cc_showed = TRUE
    OR cc_outcome IS NOT NULL
    OR tf_booked
  )                                                                        AS booked_calls,
  count(*) FILTER (WHERE qualified AND (
       matched_event_id IS NOT NULL
    OR cc_showed = TRUE
    OR cc_outcome IS NOT NULL
    OR tf_booked
  ))                                                                       AS qualified_booked_calls,
  count(*) FILTER (WHERE
       appt_outcome IN ('showed','closed','not_closed')
    OR cc_showed = TRUE
    OR cc_outcome IN ('showed','closed','not_closed')
  )                                                                        AS live_calls,
  count(*) FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed') AS closes,
  COALESCE(sum(GREATEST(appt_revenue, cc_revenue, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)    AS revenue_attributed,
  COALESCE(sum(GREATEST(appt_cash, cc_cash, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)    AS cash_attributed
FROM public.lib_typeform_response_outcome
WHERE ad_id IS NOT NULL
GROUP BY ad_id;
GRANT SELECT ON public.lib_typeform_ad_attribution TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_typeform_adset_attribution CASCADE;
CREATE VIEW public.lib_typeform_adset_attribution AS
SELECT
  adset_id,
  count(*)                                                                 AS leads,
  count(*) FILTER (WHERE qualified)                                        AS qualified_leads,
  count(*) FILTER (WHERE
       matched_event_id IS NOT NULL
    OR cc_showed = TRUE
    OR cc_outcome IS NOT NULL
    OR tf_booked
  )                                                                        AS booked_calls,
  count(*) FILTER (WHERE qualified AND (
       matched_event_id IS NOT NULL
    OR cc_showed = TRUE
    OR cc_outcome IS NOT NULL
    OR tf_booked
  ))                                                                       AS qualified_booked_calls,
  count(*) FILTER (WHERE
       appt_outcome IN ('showed','closed','not_closed')
    OR cc_showed = TRUE
    OR cc_outcome IN ('showed','closed','not_closed')
  )                                                                        AS live_calls,
  count(*) FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed') AS closes,
  COALESCE(sum(GREATEST(appt_revenue, cc_revenue, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)    AS revenue_attributed,
  COALESCE(sum(GREATEST(appt_cash, cc_cash, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)    AS cash_attributed
FROM public.lib_typeform_response_outcome
WHERE adset_id IS NOT NULL
GROUP BY adset_id;
GRANT SELECT ON public.lib_typeform_adset_attribution TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_typeform_campaign_attribution CASCADE;
CREATE VIEW public.lib_typeform_campaign_attribution AS
SELECT
  utm_campaign,
  count(*)                                                                 AS leads,
  count(*) FILTER (WHERE qualified)                                        AS qualified_leads,
  count(*) FILTER (WHERE
       matched_event_id IS NOT NULL
    OR cc_showed = TRUE
    OR cc_outcome IS NOT NULL
    OR tf_booked
  )                                                                        AS booked_calls,
  count(*) FILTER (WHERE qualified AND (
       matched_event_id IS NOT NULL
    OR cc_showed = TRUE
    OR cc_outcome IS NOT NULL
    OR tf_booked
  ))                                                                       AS qualified_booked_calls,
  count(*) FILTER (WHERE
       appt_outcome IN ('showed','closed','not_closed')
    OR cc_showed = TRUE
    OR cc_outcome IN ('showed','closed','not_closed')
  )                                                                        AS live_calls,
  count(*) FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed') AS closes,
  COALESCE(sum(GREATEST(appt_revenue, cc_revenue, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)    AS revenue_attributed,
  COALESCE(sum(GREATEST(appt_cash, cc_cash, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)    AS cash_attributed
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
  tfr.ending_screen,
  tfr.utm_campaign,
  tfr.utm_term                                          AS adset_id,
  tfr.ad_id,
  o.matched_event_id,
  COALESCE(
        o.matched_event_id IS NOT NULL
     OR o.cc_showed = TRUE
     OR o.cc_outcome IS NOT NULL
     OR public.tfr_self_reported_booked(tfr.ending_screen),
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
