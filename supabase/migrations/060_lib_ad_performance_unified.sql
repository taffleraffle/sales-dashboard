-- 059_lib_ad_performance_unified.sql
--
-- Unified per-ad performance view + pre-baked pivot functions for the
-- Creative Insights dashboard.
--
-- Depends on:
--   - public.ads                       (mig 011)
--   - public.ad_daily_stats            (mig 011 — per (ad_id, date) spend)
--   - public.lib_ghl_leads_per_ad      (mig 046)
--   - public.lib_ghl_booked_detail     (mig 049 — has ad_id)
--   - public.lib_close_per_ad          (mig 041 — closes + revenue per ad)
--   - public.creative_attributes       (mig 058)
--
-- Winner heuristic (locked by Ben in plan):
--   effective_winner =
--     COALESCE(manual_winner_override,
--              spend >= 1000 AND booked >= 2 AND spend / booked <= 300)
--
-- All money values assumed USD (matches marketing_daily.spend convention).
--
-- Apply via supabase db push.

BEGIN;

-- ─── 1. lib_ghl_booked_per_ad ─────────────────────────────────────────
-- Per-ad rollup of GHL appointments (not in mig 049 — that built the
-- detail + adset + campaign views but skipped per-ad).
DROP VIEW IF EXISTS public.lib_ghl_booked_per_ad CASCADE;
CREATE VIEW public.lib_ghl_booked_per_ad AS
SELECT
  ad_id,
  COUNT(*)                              AS booked,
  MIN(landed_at)                        AS first_booked_at,
  MAX(landed_at)                        AS last_booked_at
FROM public.lib_ghl_booked_detail
WHERE ad_id IS NOT NULL
GROUP BY ad_id;

GRANT SELECT ON public.lib_ghl_booked_per_ad TO anon, authenticated;


-- ─── 2. lib_ad_performance(since, until) ─────────────────────────────
-- One row per ad over the given date window. Joins spend +
-- leads/booked/closes + creative attributes + auto-winner flag.
--
-- Used by:
--   - AdsInsights.jsx (lists, pivots, winners table)
--   - AdsGenerator.jsx (winner-pattern context for the LLM)
DROP FUNCTION IF EXISTS public.lib_ad_performance(DATE, DATE) CASCADE;

CREATE OR REPLACE FUNCTION public.lib_ad_performance(since DATE, until DATE)
RETURNS TABLE (
  ad_id                    TEXT,
  ad_name                  TEXT,
  campaign_name            TEXT,
  adset_name               TEXT,
  offer_slug               TEXT,
  vertical                 TEXT,

  spend                    NUMERIC,
  impressions              BIGINT,
  clicks                   BIGINT,
  leads                    BIGINT,
  booked                   BIGINT,
  closes                   BIGINT,
  revenue                  NUMERIC,
  cash                     NUMERIC,

  cost_per_lead            NUMERIC,
  cost_per_booked          NUMERIC,
  cost_per_close           NUMERIC,
  close_rate               NUMERIC,

  hook_type                TEXT,
  message_frame            TEXT,
  mechanism_reveal         TEXT,
  proof_character          TEXT,
  pain_angle               TEXT,
  funnel_stage             TEXT,
  awareness_level          TEXT,
  length_bucket            TEXT,
  format                   TEXT,
  actor                    TEXT,

  manual_winner_override   BOOLEAN,
  winner_auto_detected     BOOLEAN,
  effective_winner         BOOLEAN,

  extracted_at             TIMESTAMPTZ,
  attributes_complete      BOOLEAN
)
LANGUAGE SQL STABLE AS $$
  WITH spend_window AS (
    SELECT
      ad_id,
      SUM(spend)        AS spend,
      SUM(impressions)  AS impressions,
      SUM(clicks)       AS clicks
    FROM public.ad_daily_stats
    WHERE date BETWEEN since AND until
    GROUP BY ad_id
  ),
  leads_window AS (
    -- Per-ad lead count in the [since, until] window. Goes direct to
    -- ghl_contacts because lib_ghl_leads_per_ad pre-aggregates and only
    -- exposes first_lead_at — filtering on that proxy would zero out
    -- every ad whose first lead landed before the window, even when
    -- the window contains 40 leads from that ad.
    SELECT
      COALESCE(last_ad_id, first_ad_id) AS ad_id,
      COUNT(*) AS leads
    FROM public.ghl_contacts
    WHERE COALESCE(last_ad_id, first_ad_id) IS NOT NULL
      AND date_added::date BETWEEN since AND until
    GROUP BY COALESCE(last_ad_id, first_ad_id)
  ),
  booked_window AS (
    SELECT
      ad_id,
      COUNT(*) FILTER (WHERE landed_at::date BETWEEN since AND until) AS booked
    FROM public.lib_ghl_booked_detail
    WHERE ad_id IS NOT NULL
    GROUP BY ad_id
  ),
  closes_window AS (
    SELECT
      resolved_ad_id AS ad_id,
      COUNT(*)                          FILTER (WHERE created_at::date BETWEEN since AND until) AS closes,
      COALESCE(SUM(revenue)        FILTER (WHERE created_at::date BETWEEN since AND until), 0)  AS revenue,
      COALESCE(SUM(cash_collected) FILTER (WHERE created_at::date BETWEEN since AND until), 0)  AS cash
    FROM public.lib_close_resolved
    WHERE resolved_ad_id IS NOT NULL
    GROUP BY resolved_ad_id
  )
  SELECT
    a.ad_id,
    a.ad_name,
    a.campaign_name,
    a.adset_name,
    ca.offer_slug,
    ca.vertical,

    COALESCE(s.spend, 0)              AS spend,
    COALESCE(s.impressions, 0)        AS impressions,
    COALESCE(s.clicks, 0)             AS clicks,
    COALESCE(l.leads, 0)              AS leads,
    COALESCE(b.booked, 0)             AS booked,
    COALESCE(c.closes, 0)             AS closes,
    COALESCE(c.revenue, 0)            AS revenue,
    COALESCE(c.cash, 0)               AS cash,

    CASE WHEN COALESCE(l.leads, 0)  > 0 THEN s.spend / l.leads  END AS cost_per_lead,
    CASE WHEN COALESCE(b.booked, 0) > 0 THEN s.spend / b.booked END AS cost_per_booked,
    CASE WHEN COALESCE(c.closes, 0) > 0 THEN s.spend / c.closes END AS cost_per_close,
    CASE WHEN COALESCE(b.booked, 0) > 0 THEN c.closes::numeric / b.booked END AS close_rate,

    ca.hook_type,
    ca.message_frame,
    ca.mechanism_reveal,
    ca.proof_character,
    ca.pain_angle,
    ca.funnel_stage,
    ca.awareness_level,
    ca.length_bucket,
    ca.format,
    ca.actor,

    ca.manual_winner_override,
    -- Auto-winner: spend >= 1000 AND booked >= 2 AND cost_per_booked <= 300
    COALESCE(
      s.spend >= 1000
        AND b.booked >= 2
        AND (s.spend / NULLIF(b.booked, 0)) <= 300,
      FALSE
    ) AS winner_auto_detected,
    -- Effective winner: manual override wins if set, else auto-detected
    COALESCE(
      ca.manual_winner_override,
      s.spend >= 1000
        AND b.booked >= 2
        AND (s.spend / NULLIF(b.booked, 0)) <= 300,
      FALSE
    ) AS effective_winner,

    ca.extracted_at,
    -- attributes_complete = all 9 LLM-extractable fields populated
    (ca.hook_type IS NOT NULL
       AND ca.message_frame IS NOT NULL
       AND ca.mechanism_reveal IS NOT NULL
       AND ca.proof_character IS NOT NULL
       AND ca.pain_angle IS NOT NULL
       AND ca.funnel_stage IS NOT NULL
       AND ca.awareness_level IS NOT NULL
       AND ca.length_bucket IS NOT NULL
       AND ca.format IS NOT NULL
    ) AS attributes_complete

  FROM public.ads a
  LEFT JOIN spend_window  s  ON s.ad_id  = a.ad_id
  LEFT JOIN leads_window  l  ON l.ad_id  = a.ad_id
  LEFT JOIN booked_window b  ON b.ad_id  = a.ad_id
  LEFT JOIN closes_window c  ON c.ad_id  = a.ad_id
  LEFT JOIN public.creative_attributes ca ON ca.ad_id = a.ad_id;
$$;

GRANT EXECUTE ON FUNCTION public.lib_ad_performance(DATE, DATE) TO anon, authenticated;


-- ─── 3. lib_perf_by_attribute(attr, since, until) ────────────────────
-- Pre-baked single-dimension pivot. Returns one row per distinct value
-- of the given attribute with rollup metrics.
--
-- Allowed attr values: hook_type, message_frame, mechanism_reveal,
-- proof_character, pain_angle, funnel_stage, awareness_level,
-- length_bucket, format, actor, vertical.
--
-- Used by AdsInsights bar-chart widgets.
DROP FUNCTION IF EXISTS public.lib_perf_by_attribute(TEXT, DATE, DATE) CASCADE;

CREATE OR REPLACE FUNCTION public.lib_perf_by_attribute(attr TEXT, since DATE, until DATE)
RETURNS TABLE (
  attribute_value   TEXT,
  ads_count         BIGINT,
  spend             NUMERIC,
  leads             BIGINT,
  booked            BIGINT,
  closes            BIGINT,
  revenue           NUMERIC,
  cost_per_lead     NUMERIC,
  cost_per_booked   NUMERIC,
  cost_per_close    NUMERIC,
  close_rate        NUMERIC,
  winners           BIGINT
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  -- Whitelist attr name to prevent SQL injection in dynamic SQL
  IF attr NOT IN ('hook_type','message_frame','mechanism_reveal','proof_character',
                  'pain_angle','funnel_stage','awareness_level','length_bucket',
                  'format','actor','vertical','offer_slug') THEN
    RAISE EXCEPTION 'lib_perf_by_attribute: unsupported attr "%"', attr;
  END IF;

  RETURN QUERY EXECUTE format($f$
    SELECT
      %1$I AS attribute_value,
      COUNT(*)                                       AS ads_count,
      COALESCE(SUM(spend),    0)                     AS spend,
      COALESCE(SUM(leads),    0)                     AS leads,
      COALESCE(SUM(booked),   0)                     AS booked,
      COALESCE(SUM(closes),   0)                     AS closes,
      COALESCE(SUM(revenue),  0)                     AS revenue,
      CASE WHEN SUM(leads)  > 0 THEN SUM(spend)::numeric / SUM(leads)  END AS cost_per_lead,
      CASE WHEN SUM(booked) > 0 THEN SUM(spend)::numeric / SUM(booked) END AS cost_per_booked,
      CASE WHEN SUM(closes) > 0 THEN SUM(spend)::numeric / SUM(closes) END AS cost_per_close,
      CASE WHEN SUM(booked) > 0 THEN SUM(closes)::numeric / SUM(booked) END AS close_rate,
      COUNT(*) FILTER (WHERE effective_winner)       AS winners
    FROM public.lib_ad_performance(%2$L::date, %3$L::date)
    WHERE %1$I IS NOT NULL
    GROUP BY %1$I
    ORDER BY booked DESC NULLS LAST, spend DESC NULLS LAST
  $f$, attr, since, until);
END;
$$;

GRANT EXECUTE ON FUNCTION public.lib_perf_by_attribute(TEXT, DATE, DATE) TO anon, authenticated;


NOTIFY pgrst, 'reload schema';

COMMIT;
