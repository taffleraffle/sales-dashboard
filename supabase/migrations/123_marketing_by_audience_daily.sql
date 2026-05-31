-- Per-audience daily marketing rollup (Ben 2026-06-01).
--
-- The Marketing page (/sales/marketing) reads marketing_tracker which is a
-- DAILY AGGREGATE with no campaign info. Clicking "Restoration" filtered
-- entries by entry.campaign_name → which doesn't exist → every row dropped
-- → page showed $0 spend.
--
-- This view computes the same daily-rollup shape but split by audience
-- (Restoration, Electricians, Accounting, etc.), drawing from the canonical
-- per-campaign sources:
--
--   spend             → ad_daily_stats joined to ads (truth, complete)
--   leads             → typeform_responses where ad_id resolves to campaign
--   qualified_bookings→ lib_typeform_response_detail qualified + booked
--   live_calls        → lib_ghl_lives_detail
--   closes / revenue  → lib_close_resolved
--
-- Audience is parsed from ads.campaign_name with the
-- campaign_audience_overrides table taking precedence (manual overrides
-- always win). New verticals added to audience_from_campaign_name() flow
-- through automatically — no client-specific code.

BEGIN;

-- Reusable parser for campaign_name → audience. Returns title-case
-- audience names matching the MarketingPerformance.jsx canonical strings
-- ("Restoration", "Electricians", "Accounting").
CREATE OR REPLACE FUNCTION public.audience_from_campaign_name(p text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p ILIKE '%restoration%'  OR p ILIKE '%resto%'   THEN 'Restoration'
    WHEN p ILIKE '%remodel%'                              THEN 'Restoration'
    WHEN p ILIKE '%electrician%'                          THEN 'Electricians'
    WHEN p ILIKE '%accounting%'   OR p ILIKE '%bookkeep%' THEN 'Accounting'
    WHEN p ILIKE '%plumb%'                                THEN 'Plumbing'
    WHEN p ILIKE '%hvac%'                                 THEN 'HVAC'
    WHEN p ILIKE '%pool%'                                 THEN 'Pool Builders'
    WHEN p ILIKE '%real estate%' OR p ILIKE '%realtor%'   THEN 'Real Estate'
    WHEN p ILIKE '%roofing%'      OR p ILIKE '%roofer%'   THEN 'Roofing'
    ELSE 'Unknown'
  END
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- lib_marketing_by_audience_daily
-- One row per (date, audience). Matches the marketing_tracker column shape
-- as closely as possible so the Marketing page can drop it in when the
-- audience filter is active.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.lib_marketing_by_audience_daily AS
WITH
-- Each ad's resolved audience (override > campaign-name parse). One row per ad.
ad_audience AS (
  SELECT a.ad_id,
         a.campaign_id,
         a.campaign_name,
         COALESCE(o.audience_slug, audience_from_campaign_name(a.campaign_name)) AS audience_raw
    FROM ads a
    LEFT JOIN campaign_audience_overrides o ON o.campaign_id = a.campaign_id
),
-- Normalise override audience_slug to the same title-case keys ('restoration' → 'Restoration')
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
-- 1. SPEND per (date, audience) — truth from ad_daily_stats
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
-- 2. LEADS per (date, audience) — typeform submissions resolved to an ad
leads_d AS (
  SELECT date_trunc('day', tr.submitted_at AT TIME ZONE 'UTC')::date AS date,
         aa.audience,
         COUNT(*)                                AS leads,
         COUNT(*) FILTER (WHERE tr.qualified)   AS qualified_leads
    FROM typeform_responses tr
    JOIN ad_audience_n aa ON aa.ad_id = tr.ad_id
   GROUP BY 1, 2
),
-- 3. QUALIFIED BOOKINGS per (date, audience) — qualified AND is_booked
qual_bookings_d AS (
  SELECT date_trunc('day', d.submitted_at AT TIME ZONE 'UTC')::date AS date,
         aa.audience,
         COUNT(*) FILTER (WHERE d.qualified AND d.is_booked) AS qualified_bookings
    FROM lib_typeform_response_detail d
    JOIN ad_audience_n aa ON aa.ad_id = d.ad_id
   GROUP BY 1, 2
),
-- 4. LIVE CALLS per (date, audience) — uses the smart resolver chain
live_d AS (
  SELECT date_trunc('day', v.landed_at AT TIME ZONE 'UTC')::date AS date,
         COALESCE(audience_from_campaign_name(v.utm_campaign), 'Unknown') AS audience,
         COUNT(*) AS live_calls
    FROM lib_ghl_lives_detail v
   WHERE v.utm_campaign <> 'REFERRAL'  -- referrals don't roll up to a paid audience
   GROUP BY 1, 2
),
-- 5. CLOSES + REVENUE + CASH per (date, audience)
close_d AS (
  SELECT date_trunc('day', c.created_at AT TIME ZONE 'UTC')::date AS date,
         COALESCE(audience_from_campaign_name(c.resolved_campaign), 'Unknown') AS audience,
         COUNT(*) AS closes,
         SUM(c.revenue) AS revenue,
         SUM(c.cash_collected) AS cash
    FROM lib_close_resolved c
   WHERE c.resolved_campaign <> 'REFERRAL'
   GROUP BY 1, 2
),
-- Cartesian union of all dates × audiences we've seen
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
