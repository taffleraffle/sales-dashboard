-- 052_tighten_typeform_closer_match.sql
-- Fix: lib_typeform_response_outcome was fuzzing typeform → closer_calls on
-- first-name only when last_name was NULL or < 2 chars. Result: every
-- typeform submission with first_name "Mike" inherited the most recent
-- closer_call whose prospect_name started with "Mike" — outcome, revenue,
-- cash and all. Confirmed 2026-05-14 from the Ads dashboard close
-- drilldown showing three different Mikes (Sozzo, Hagan, Mac Home
-- Services) all stamped TYPEFORM·UNRESOLVED with identical $9k / $500
-- inherited from a single Mike-prefix closer_call.
--
-- Tightenings applied to the cc LATERAL join:
--   1. Require typeform last_name be present AND ≥ 2 chars (drop the
--      NULL/short fallback that allowed first-name-only matching).
--   2. Require both first_name AND last_name appear in
--      closer_calls.prospect_name (case-insensitive).
--   3. Add date window: cc.created_at within 90 days of tfr.submitted_at
--      so an old "Mike Smith" closer_call doesn't poison a new "Mike
--      Sozzo" typeform.
--
-- Result: false-positive is_closed / is_live drops dramatically.
-- Cost: typeform submissions without a last_name no longer auto-link
-- to closer_calls (returns to relying on the appt LATERAL via email/
-- phone for those rows).
--
-- Idempotent. Apply via supabase db push.

BEGIN;

DROP VIEW IF EXISTS public.lib_typeform_response_outcome CASCADE;
CREATE VIEW public.lib_typeform_response_outcome AS
SELECT
  tfr.response_id,
  tfr.ad_id,
  tfr.utm_term       AS adset_id,
  tfr.utm_campaign,
  tfr.qualified,
  -- Best matching GHL appointment (email or phone) — unchanged
  appt.ghl_event_id           AS matched_event_id,
  appt.outcome                AS appt_outcome,
  appt.revenue                AS appt_revenue,
  appt.cash_collected         AS appt_cash,
  -- Best matching closer_call (REQUIRES last_name match + 90-day window)
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
    -- TIGHTENED 2026-05-14: last_name MUST exist and be ≥ 2 chars, AND
    -- must appear in the closer_call's prospect_name. Drops the
    -- "Mike → any Mike closer_call" fuzz that was inflating closes/lives.
    AND tfr.last_name IS NOT NULL
    AND length(tfr.last_name) >= 2
    AND c.prospect_name ILIKE (tfr.first_name || '%')
    AND c.prospect_name ILIKE ('%' || tfr.last_name || '%')
    -- Date window: the closer_call must have happened within 90 days of
    -- the typeform submission. Prevents ancient closer_calls from
    -- poisoning new typeform leads with the same first/last name combo.
    AND c.created_at >= tfr.submitted_at - INTERVAL '90 days'
    AND c.created_at <= tfr.submitted_at + INTERVAL '90 days'
  ORDER BY c.created_at DESC
  LIMIT 1
) cc ON true;

GRANT SELECT ON public.lib_typeform_response_outcome TO anon, authenticated;

-- Rebuild rollup views that depend on the outcome view. Same shape, same
-- field semantics — just driven by the tightened outcome view above.

DROP VIEW IF EXISTS public.lib_typeform_ad_attribution CASCADE;
CREATE VIEW public.lib_typeform_ad_attribution AS
SELECT
  ad_id,
  count(*)                                                                AS leads,
  count(*) FILTER (WHERE qualified)                                       AS qualified_leads,
  count(*) FILTER (WHERE matched_event_id IS NOT NULL)                    AS booked_calls,
  count(*) FILTER (WHERE matched_event_id IS NOT NULL AND qualified)      AS qualified_booked_calls,
  count(*) FILTER (WHERE
       appt_outcome IN ('showed','closed','not_closed')
    OR cc_showed = TRUE
    OR cc_outcome IN ('showed','closed','not_closed')
  )                                                                       AS live_calls,
  count(*) FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed') AS closes,
  COALESCE(sum(GREATEST(appt_revenue, cc_revenue, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)   AS revenue_attributed,
  COALESCE(sum(GREATEST(appt_cash, cc_cash, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)   AS cash_attributed
FROM public.lib_typeform_response_outcome
WHERE ad_id IS NOT NULL
GROUP BY ad_id;
GRANT SELECT ON public.lib_typeform_ad_attribution TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_typeform_adset_attribution CASCADE;
CREATE VIEW public.lib_typeform_adset_attribution AS
SELECT
  adset_id,
  count(*)                                                                AS leads,
  count(*) FILTER (WHERE qualified)                                       AS qualified_leads,
  count(*) FILTER (WHERE matched_event_id IS NOT NULL)                    AS booked_calls,
  count(*) FILTER (WHERE matched_event_id IS NOT NULL AND qualified)      AS qualified_booked_calls,
  count(*) FILTER (WHERE
       appt_outcome IN ('showed','closed','not_closed')
    OR cc_showed = TRUE
    OR cc_outcome IN ('showed','closed','not_closed')
  )                                                                       AS live_calls,
  count(*) FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed') AS closes,
  COALESCE(sum(GREATEST(appt_revenue, cc_revenue, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)   AS revenue_attributed,
  COALESCE(sum(GREATEST(appt_cash, cc_cash, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)   AS cash_attributed
FROM public.lib_typeform_response_outcome
WHERE adset_id IS NOT NULL
GROUP BY adset_id;
GRANT SELECT ON public.lib_typeform_adset_attribution TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_typeform_campaign_attribution CASCADE;
CREATE VIEW public.lib_typeform_campaign_attribution AS
SELECT
  utm_campaign,
  count(*)                                                                AS leads,
  count(*) FILTER (WHERE qualified)                                       AS qualified_leads,
  count(*) FILTER (WHERE matched_event_id IS NOT NULL)                    AS booked_calls,
  count(*) FILTER (WHERE matched_event_id IS NOT NULL AND qualified)      AS qualified_booked_calls,
  count(*) FILTER (WHERE
       appt_outcome IN ('showed','closed','not_closed')
    OR cc_showed = TRUE
    OR cc_outcome IN ('showed','closed','not_closed')
  )                                                                       AS live_calls,
  count(*) FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed') AS closes,
  COALESCE(sum(GREATEST(appt_revenue, cc_revenue, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)   AS revenue_attributed,
  COALESCE(sum(GREATEST(appt_cash, cc_cash, 0))
    FILTER (WHERE appt_outcome = 'closed' OR cc_outcome = 'closed'), 0)   AS cash_attributed
FROM public.lib_typeform_response_outcome
WHERE utm_campaign IS NOT NULL
GROUP BY utm_campaign;
GRANT SELECT ON public.lib_typeform_campaign_attribution TO anon, authenticated;

-- Rebuild the per-response detail view (defined in 038) since it
-- CASCADE-dropped when we dropped lib_typeform_response_outcome above.
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
