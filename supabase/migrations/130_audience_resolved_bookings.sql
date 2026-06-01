-- Resolve audience for every strategy-call booking + drop-in views the
-- Marketing-page drilldowns can filter by audience (Ben 2026-06-01).
--
-- The Marketing page audience tabs (Restoration / Electricians / Australia /
-- All) correctly filter the TILE counts via lib_marketing_by_audience_daily.
-- But the DRILLDOWNS (Bookings, Leads, Closes, etc.) bypass the audience
-- filter — `fetchBookings()` reads ghl_appointments without any audience
-- join, so the list shows ALL prospects regardless of which tab is active.
-- Ben caught Hector (an Electrician) appearing in the Restoration drilldown.
--
-- Fix in two layers:
-- 1. Promote ad_audience_n out of lib_marketing_by_audience_daily into a
--    reusable view (lib_ad_audience). Single source of truth for "what
--    audience does this ad belong to".
-- 2. New view lib_strategy_booking_resolved: one row per non-cancelled
--    strategy booking with an `audience` column resolved via a ladder:
--      a. typeform email match → ad_id → audience          (strongest)
--      b. calendar_name parse (RestorationConnect, etc.)   (medium)
--      c. 'Unknown'                                         (orphan)
--
-- The marketing view is then rebuilt to draw qualified_bookings from the
-- new resolved booking view so the TILE count matches what the drilldown
-- will return.

BEGIN;

-- ─── lib_ad_audience ────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.lib_ad_audience AS
WITH ad_audience AS (
  SELECT a.ad_id,
         a.campaign_id,
         a.campaign_name,
         COALESCE(o.audience_slug, audience_from_campaign_name(a.campaign_name)) AS audience_raw
    FROM ads a
    LEFT JOIN campaign_audience_overrides o ON o.campaign_id = a.campaign_id
)
SELECT ad_id, campaign_id, campaign_name,
       CASE
         WHEN audience_raw = 'restoration'    THEN 'Restoration'
         WHEN audience_raw = 'electrician'    THEN 'Electricians'
         WHEN audience_raw = 'accounting'     THEN 'Accounting'
         WHEN audience_raw = 'plumbing'       THEN 'Plumbing'
         WHEN audience_raw = 'hvac'           THEN 'HVAC'
         WHEN audience_raw = 'pool_builders'  THEN 'Pool Builders'
         WHEN audience_raw = 'real_estate'    THEN 'Real Estate'
         WHEN audience_raw = 'roofing'        THEN 'Roofing'
         WHEN audience_raw = 'australia'      THEN 'Australia'
         ELSE audience_raw
       END AS audience
FROM ad_audience;

GRANT SELECT ON public.lib_ad_audience TO anon, authenticated;

-- ─── lib_strategy_booking_resolved ──────────────────────────────────────
CREATE OR REPLACE VIEW public.lib_strategy_booking_resolved AS
WITH
-- Strategy-call calendars (keep in sync with src/utils/constants.js
-- STRATEGY_CALL_CALENDARS — when that list changes, this view needs an
-- update too).
strategy_calendars(id, audience_hint, is_dq) AS (
  VALUES
    ('9yoQVPBkNX4tWYmcDkf3', 'Restoration',    FALSE),  -- Remodeling AI
    ('cEyqCFAsPLDkUV8n982h', 'Restoration',    FALSE),  -- RestorationConnect AI
    ('HDsTrgpsFOXw9V4AkZGq', 'Restoration',    FALSE),  -- (FB) RestorationConnect
    ('aQsmGwANALCwJBI7G9vT', 'Plumbing',       FALSE),  -- PlumberConnect AI
    ('StLqrES6WMO8f3Obdu9d', 'Pool Builders',  FALSE),  -- PoolConnect AI
    ('3mLE6t6rCKDdIuIfvP9j', 'Pool Builders',  FALSE),  -- (FB) PoolConnect
    ('T5Zif5GjDwulya6novU0', NULL,             FALSE),  -- Opt Digital | Strategy (generic)
    ('gohFzPCilzwBtVfaC6fu', NULL,             TRUE ),  -- Opt Digital | DQ
    ('woLoGzGKe5fPKZU1jxY7', 'Restoration',    FALSE)   -- RestorationConnect (FB)
),
-- Deduped non-cancelled bookings: one row per contact, earliest in window wins.
bookings AS (
  SELECT DISTINCT ON (COALESCE(a.ghl_contact_id, a.contact_email))
         a.id,
         a.ghl_event_id,
         a.ghl_contact_id,
         a.contact_email,
         a.contact_name,
         a.calendar_name,
         (a.booked_at::date)        AS booked_at,
         a.appointment_date,
         a.appointment_status,
         a.revenue_tier
    FROM ghl_appointments a
    JOIN strategy_calendars sc ON sc.id = a.calendar_name
   WHERE a.appointment_status <> 'cancelled'
   ORDER BY COALESCE(a.ghl_contact_id, a.contact_email), a.booked_at ASC
),
-- Typeform match by email → ad_id → audience (strongest signal).
tf_match AS (
  SELECT DISTINCT ON (LOWER(tr.email))
         LOWER(tr.email) AS email_l,
         tr.ad_id
    FROM typeform_responses tr
   WHERE tr.email IS NOT NULL
     AND tr.ad_id IS NOT NULL
   ORDER BY LOWER(tr.email), tr.submitted_at DESC
)
SELECT b.id,
       b.ghl_event_id,
       b.ghl_contact_id,
       b.contact_email,
       b.contact_name,
       b.calendar_name,
       b.booked_at,
       b.appointment_date,
       b.appointment_status,
       b.revenue_tier,
       sc.is_dq,
       COALESCE(aa.audience, sc.audience_hint, 'Unknown') AS audience,
       CASE
         WHEN aa.audience IS NOT NULL      THEN 'typeform_email_match'
         WHEN sc.audience_hint IS NOT NULL THEN 'calendar_hint'
         ELSE                                   'unresolved'
       END AS audience_source
  FROM bookings b
  JOIN strategy_calendars sc ON sc.id = b.calendar_name
  LEFT JOIN tf_match tm     ON tm.email_l = LOWER(b.contact_email)
  LEFT JOIN lib_ad_audience aa ON aa.ad_id = tm.ad_id;

GRANT SELECT ON public.lib_strategy_booking_resolved TO anon, authenticated;

-- ─── lib_marketing_by_audience_daily (rebuilt) ──────────────────────────
-- Use lib_strategy_booking_resolved for qualified_bookings (TILE count
-- now matches DRILLDOWN list). Continues to source spend/leads/closes
-- from the existing chain.
CREATE OR REPLACE VIEW public.lib_marketing_by_audience_daily AS
WITH
spend_d AS (
  SELECT s.date,
         aa.audience,
         SUM(s.spend) AS adspend,
         SUM(s.impressions) AS impressions,
         SUM(s.clicks) AS clicks
    FROM ad_daily_stats s
    JOIN lib_ad_audience aa ON aa.ad_id = s.ad_id
   GROUP BY 1, 2
),
leads_d AS (
  SELECT date_trunc('day', tr.submitted_at AT TIME ZONE 'UTC')::date AS date,
         aa.audience,
         COUNT(*)                              AS leads,
         COUNT(*) FILTER (WHERE tr.qualified) AS qualified_leads
    FROM typeform_responses tr
    JOIN lib_ad_audience aa ON aa.ad_id = tr.ad_id
   GROUP BY 1, 2
),
-- Qualified bookings now = resolved-booking view, excluding DQ flow.
qual_bookings_d AS (
  SELECT b.booked_at AS date,
         b.audience,
         COUNT(*) AS qualified_bookings
    FROM lib_strategy_booking_resolved b
   WHERE NOT b.is_dq
   GROUP BY 1, 2
),
live_d AS (
  SELECT date_trunc('day', v.landed_at AT TIME ZONE 'UTC')::date AS date,
         COALESCE(aa.audience, audience_from_campaign_name(v.utm_campaign), 'Unknown') AS audience,
         COUNT(*) AS live_calls
    FROM lib_ghl_lives_detail v
    LEFT JOIN lib_ad_audience aa ON aa.ad_id = v.ad_id
   WHERE v.utm_campaign <> 'REFERRAL'
   GROUP BY 1, 2
),
close_d AS (
  SELECT date_trunc('day', c.created_at AT TIME ZONE 'UTC')::date AS date,
         COALESCE(aa.audience, audience_from_campaign_name(c.resolved_campaign), 'Unknown') AS audience,
         COUNT(*) AS closes,
         SUM(c.revenue) AS revenue,
         SUM(c.cash_collected) AS cash
    FROM lib_close_resolved c
    LEFT JOIN lib_ad_audience aa ON aa.ad_id = c.resolved_ad_id
   WHERE c.resolved_campaign <> 'REFERRAL'
   GROUP BY 1, 2
),
all_keys AS (
  SELECT date, audience FROM spend_d
  UNION SELECT date, audience FROM leads_d
  UNION SELECT date, audience FROM qual_bookings_d
  UNION SELECT date, audience FROM live_d
  UNION SELECT date, audience FROM close_d
)
SELECT k.date, k.audience,
       COALESCE(s.adspend, 0)             AS adspend,
       COALESCE(s.impressions, 0)         AS impressions,
       COALESCE(s.clicks, 0)              AS clicks,
       COALESCE(l.leads, 0)               AS leads,
       COALESCE(l.qualified_leads, 0)     AS qualified_leads,
       COALESCE(q.qualified_bookings, 0)  AS qualified_bookings,
       COALESCE(lv.live_calls, 0)         AS live_calls,
       COALESCE(c.closes, 0)              AS closes,
       COALESCE(c.revenue, 0)             AS trial_revenue,
       COALESCE(c.cash, 0)                AS trial_cash
  FROM all_keys k
  LEFT JOIN spend_d         s  ON s.date  = k.date AND s.audience  = k.audience
  LEFT JOIN leads_d         l  ON l.date  = k.date AND l.audience  = k.audience
  LEFT JOIN qual_bookings_d q  ON q.date  = k.date AND q.audience  = k.audience
  LEFT JOIN live_d          lv ON lv.date = k.date AND lv.audience = k.audience
  LEFT JOIN close_d         c  ON c.date  = k.date AND c.audience  = k.audience
  ORDER BY k.date DESC, k.audience;

GRANT SELECT ON public.lib_marketing_by_audience_daily TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
