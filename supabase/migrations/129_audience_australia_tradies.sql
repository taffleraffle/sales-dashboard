-- Add Australia audience (TRADIES campaigns) + retag the 2 mis-attributed
-- "SCIO - Video Ads TRADIES VSL" campaigns from Restoration to Australia
-- (Ben 2026-06-01: "Tradies is our Oz campaign, so you can call Tradies
-- Australia.")
--
-- 1. Extend audience_from_campaign_name() with a TRADIES → Australia rule
-- 2. Insert (or update) campaign_audience_overrides for the 2 known
--    TRADIES campaign_ids so spend / leads / closes route to Australia
--    instead of Restoration.
-- 3. NOTIFY pgrst so the view picks up the new parser output immediately.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Parser update
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audience_from_campaign_name(p text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    -- TRADIES = AU market (electricians / plumbers / sparkies). Check BEFORE
    -- the generic electrician/plumbing rules so 'TRADIES' wins over them.
    WHEN p ILIKE '%tradies%' OR p ILIKE '%tradie%'        THEN 'Australia'
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

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Audience normalization in the marketing view — recreate so the new
--    'australia' slug normalises to 'Australia' alongside the existing
--    vertical→Title-Case mappings.
-- ──────────────────────────────────────────────────────────────────────────
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
           WHEN audience_raw = 'australia'      THEN 'Australia'
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
  UNION SELECT date, audience FROM leads_d
  UNION SELECT date, audience FROM qual_bookings_d
  UNION SELECT date, audience FROM live_d
  UNION SELECT date, audience FROM close_d
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

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Retag the 2 mis-tagged TRADIES campaigns from Restoration to Australia.
--    These were originally overridden to 'restoration' before TRADIES was a
--    known audience. The TRADIES parser rule above would already catch them
--    if the override didn't take precedence — but we want explicit overrides
--    so future TRADIES rebrands don't drift.
-- ──────────────────────────────────────────────────────────────────────────
INSERT INTO public.campaign_audience_overrides (campaign_id, campaign_name, audience_slug)
VALUES
  ('120246952012640530', 'SCIO - Video Ads TRADIES VSL 5/18/26', 'australia'),
  ('120247035173830530', 'SCIO - Video Ads TRADIES VSL 5/19/26', 'australia')
ON CONFLICT (campaign_id) DO UPDATE
  SET audience_slug = EXCLUDED.audience_slug,
      campaign_name = EXCLUDED.campaign_name;

NOTIFY pgrst, 'reload schema';

COMMIT;
