-- Use the prospect_name calendar suffix as a top-priority audience signal
-- (Ben 2026-06-01).
--
-- Ben's critical observation: I was conflating Meta's three levels:
--   Campaign  ("OPT - ABO 3 ADSET 17/4")    - top
--   Ad set    ("Real- OPT 12/4")             - middle
--   Ad        ("Real: Booked Out")           - bottom
-- Different sources store different levels in their "utm_campaign" field:
--   typeform_responses.utm_campaign    = Meta's campaign name (top)
--   ghl_contacts.last_utm_campaign     = Meta's AD SET name   (middle) - surprise
-- So feeding ghl_contacts.last_utm_campaign through audience_from_campaign_
-- name() runs the parser on the AD SET name, which may not carry the
-- audience keyword.
--
-- Migration 125 already fixes the right level for the LOOKUP (joins via
-- ad_id - ads.campaign_name). This migration adds an EVEN BETTER signal:
-- the call's calendar suffix. When a call's prospect_name contains
-- "RestorationConnect" / "ElectricianConnect" / "RemodelerConnect", that
-- IS the audience - more authoritative than the ad's campaign name (which
-- can be a generic A/B-test bucket like "OPT - ABO 3 ADSET 17/4").
--
-- New priority chain for live_d and close_d:
--   1. prospect_name calendar suffix (RestorationConnect - Restoration)
--   2. ad_audience_n (campaign_audience_overrides - parser on campaign_name)
--   3. parser on resolved_campaign string
--   4. 'Unknown'
--
-- Also fixes the NULL-comparison bug in close_d's filter: previously
-- `WHERE c.resolved_campaign <> 'REFERRAL'` dropped NULL rows because
-- NULL <> 'REFERRAL' evaluates to NULL (not TRUE). Switched to IS DISTINCT
-- FROM.

BEGIN;

-- audience_from_prospect_name returns lowercase ('restoration', etc.).
-- We need title-case ('Restoration') to match the audience labels.
CREATE OR REPLACE FUNCTION public.prospect_name_audience_title(p text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE audience_from_prospect_name(p)
    WHEN 'restoration' THEN 'Restoration'
    WHEN 'electrician' THEN 'Electricians'
    WHEN 'accounting'  THEN 'Accounting'
    WHEN 'remodeler'   THEN 'Restoration'  -- remodeler rolls up to restoration
    WHEN 'service'     THEN 'Restoration'  -- ServiceConnect - restoration per Ben
    WHEN 'plumbing'    THEN 'Plumbing'
    WHEN 'hvac'        THEN 'HVAC'
    ELSE NULL
  END
$$;

CREATE OR REPLACE VIEW public.lib_marketing_by_audience_daily AS
WITH
ad_audience AS (
  SELECT a.ad_id,
         a.campaign_id,
         a.campaign_name,
         COALESCE(o.audience_slug, audience_from_campaign_name(a.campaign_name)) AS audience_raw
    FROM ads a
    LEFT JOIN campaign_audience_overrides o ON o.campaign_id = a.campaign_id
),
ad_audience_n AS (
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
           ELSE audience_raw
         END AS audience
    FROM ad_audience
),
spend_d AS (
  SELECT s.date,
         aa.audience,
         SUM(s.spend) AS adspend,
         SUM(s.impressions) AS impressions,
         SUM(s.clicks) AS clicks
    FROM ad_daily_stats s
    JOIN ad_audience_n aa ON aa.ad_id = s.ad_id
   GROUP BY 1, 2
),
leads_d AS (
  SELECT date_trunc('day', tr.submitted_at AT TIME ZONE 'UTC')::date AS date,
         aa.audience,
         COUNT(*)                                AS leads,
         COUNT(*) FILTER (WHERE tr.qualified)   AS qualified_leads
    FROM typeform_responses tr
    JOIN ad_audience_n aa ON aa.ad_id = tr.ad_id
   GROUP BY 1, 2
),
qual_bookings_d AS (
  SELECT date_trunc('day', d.submitted_at AT TIME ZONE 'UTC')::date AS date,
         aa.audience,
         COUNT(*) FILTER (WHERE d.qualified AND d.is_booked) AS qualified_bookings
    FROM lib_typeform_response_detail d
    JOIN ad_audience_n aa ON aa.ad_id = d.ad_id
   GROUP BY 1, 2
),
-- LIVE - prospect_name suffix first, then ad's audience, then parse
live_d AS (
  SELECT date_trunc('day', v.landed_at AT TIME ZONE 'UTC')::date AS date,
         COALESCE(
           prospect_name_audience_title(v.display_name),  -- 1: RestorationConnect - Restoration
           aa.audience,                                    -- 2: via ad_id - overrides/parser
           audience_from_campaign_name(v.utm_campaign),    -- 3: parse the string
           'Unknown'
         ) AS audience,
         COUNT(*) AS live_calls
    FROM lib_ghl_lives_detail v
    LEFT JOIN ad_audience_n aa ON aa.ad_id = v.ad_id
   WHERE v.utm_campaign IS DISTINCT FROM 'REFERRAL'
   GROUP BY 1, 2
),
-- CLOSES - same priority chain. Also fixes the NULL filter bug:
-- previously `<> 'REFERRAL'` dropped rows where resolved_campaign was NULL
-- (NULL <> 'REFERRAL' = NULL = not TRUE). IS DISTINCT FROM keeps them.
close_d AS (
  SELECT date_trunc('day', c.created_at AT TIME ZONE 'UTC')::date AS date,
         COALESCE(
           prospect_name_audience_title(c.prospect_name),
           aa.audience,
           audience_from_campaign_name(c.resolved_campaign),
           'Unknown'
         ) AS audience,
         COUNT(*) AS closes,
         SUM(c.revenue) AS revenue,
         SUM(c.cash_collected) AS cash
    FROM lib_close_resolved c
    LEFT JOIN ad_audience_n aa ON aa.ad_id = c.resolved_ad_id
   WHERE c.resolved_campaign IS DISTINCT FROM 'REFERRAL'
   GROUP BY 1, 2
),
all_keys AS (
  SELECT date, audience FROM spend_d
  UNION
  SELECT date, audience FROM leads_d
  UNION
  SELECT date, audience FROM qual_bookings_d
  UNION
  SELECT date, audience FROM live_d
  UNION
  SELECT date, audience FROM close_d
)
SELECT k.date,
       k.audience,
       COALESCE(s.adspend, 0)              AS adspend,
       COALESCE(s.impressions, 0)          AS impressions,
       COALESCE(s.clicks, 0)               AS clicks,
       COALESCE(l.leads, 0)                AS leads,
       COALESCE(l.qualified_leads, 0)      AS qualified_leads,
       COALESCE(q.qualified_bookings, 0)   AS qualified_bookings,
       COALESCE(lv.live_calls, 0)          AS live_calls,
       COALESCE(c.closes, 0)               AS closes,
       COALESCE(c.revenue, 0)              AS trial_revenue,
       COALESCE(c.cash, 0)                 AS trial_cash
  FROM all_keys k
  LEFT JOIN spend_d           s  ON s.date = k.date AND s.audience = k.audience
  LEFT JOIN leads_d           l  ON l.date = k.date AND l.audience = k.audience
  LEFT JOIN qual_bookings_d   q  ON q.date = k.date AND q.audience = k.audience
  LEFT JOIN live_d            lv ON lv.date = k.date AND lv.audience = k.audience
  LEFT JOIN close_d           c  ON c.date = k.date AND c.audience = k.audience
  ORDER BY k.date DESC, k.audience;

GRANT SELECT ON public.lib_marketing_by_audience_daily TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
