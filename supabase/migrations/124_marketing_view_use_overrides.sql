-- Make lib_marketing_by_audience_daily honor campaign_audience_overrides
-- for the live + close CTEs (Ben 2026-06-01).
--
-- Bug: after Ben classified "OPT - VSL - ABO CREATIVE" etc. as Restoration
-- in campaign_audience_overrides, spend correctly moved into Restoration
-- (spend_d uses ad_audience_n which consults the overrides). But live_calls
-- and closes for those same campaigns stayed in "Unknown" because live_d
-- and close_d only looked at v.utm_campaign / c.resolved_campaign strings
-- and ran them through the name parser, ignoring the override table.
--
-- Fix: prefer ad_audience_n lookup by ad_id; fall back to the name parser
-- when ad_id is null (referrals / manually-overridden calls without an
-- ad_id). One source of truth for audience resolution everywhere.

BEGIN;

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
-- live + close CTEs now prefer ad_audience lookup over raw name parse.
-- Falls back to parser only when no ad_id is matched (e.g. manually-overridden
-- calls where override sets utm_campaign but no ad_id).
live_d AS (
  SELECT date_trunc('day', v.landed_at AT TIME ZONE 'UTC')::date AS date,
         COALESCE(
           aa.audience,
           audience_from_campaign_name(v.utm_campaign),
           'Unknown'
         ) AS audience,
         COUNT(*) AS live_calls
    FROM lib_ghl_lives_detail v
    LEFT JOIN ad_audience_n aa ON aa.ad_id = v.ad_id
   WHERE v.utm_campaign <> 'REFERRAL'
   GROUP BY 1, 2
),
close_d AS (
  SELECT date_trunc('day', c.created_at AT TIME ZONE 'UTC')::date AS date,
         COALESCE(
           aa.audience,
           audience_from_campaign_name(c.resolved_campaign),
           'Unknown'
         ) AS audience,
         COUNT(*) AS closes,
         SUM(c.revenue) AS revenue,
         SUM(c.cash_collected) AS cash
    FROM lib_close_resolved c
    LEFT JOIN ad_audience_n aa ON aa.ad_id = c.resolved_ad_id
   WHERE c.resolved_campaign <> 'REFERRAL'
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
