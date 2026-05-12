-- 036_typeform_attribution_live_calls.sql
-- Fix: ghl_appointments.outcome is null for 99% of rows (it only gets set
-- during EOD reconciliation, which lags). The closer EOD form writes
-- per-prospect outcomes into public.closer_calls keyed on prospect_name —
-- that's where live-call + close data actually lives today.
--
-- Update the three lib_typeform_*_attribution views to LEFT JOIN closer_calls
-- via case-insensitive prospect_name → first_name match, and prefer
-- closer_calls.showed / closer_calls.outcome when the appointment-level
-- outcome is null.
--
-- Idempotent.  Apply via: supabase db push.

BEGIN;

-- Helper: a per-typeform-response best-effort outcome lookup that prefers
-- ghl_appointments.outcome (set after reconciliation) and falls back to a
-- name match against closer_calls. Wrapped in a view rather than a function
-- so the planner can optimise.
DROP VIEW IF EXISTS public.lib_typeform_response_outcome CASCADE;
CREATE VIEW public.lib_typeform_response_outcome AS
SELECT
  tfr.response_id,
  tfr.ad_id,
  tfr.utm_term       AS adset_id,
  tfr.utm_campaign,
  tfr.qualified,
  -- Best matching GHL appointment (email or phone)
  appt.ghl_event_id           AS matched_event_id,
  appt.outcome                AS appt_outcome,
  appt.revenue                AS appt_revenue,
  appt.cash_collected         AS appt_cash,
  -- Best matching closer_call (by first-name token in prospect_name)
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

-- ─────────────────────────────────────────────────────────────────
-- Rebuild the three rollup views on top of the new outcome view.
-- live_calls   = appt.outcome in (showed/closed/not_closed)  OR  cc.showed = true
-- closes       = appt.outcome = 'closed'                      OR  cc.outcome = 'closed'
-- booked_calls = matched_event_id IS NOT NULL                 (unchanged)
-- ─────────────────────────────────────────────────────────────────

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

NOTIFY pgrst, 'reload schema';

COMMIT;
