-- 060_creative_attribute_pivots.sql
--
-- Additional pivot RPCs for the Creative Insights dashboard:
--
--   1. lib_perf_heatmap(attr_a, attr_b, since, until)
--      Two-attribute cross-pivot — for the heatmap widget.
--
--   2. lib_winning_attributes(since, until)
--      "Most consistent winning attributes" — for each attribute_name,
--      lists the values appearing in 2+ winners with average CPA.
--      This is what answers Ben's question: "what variables in the
--      winners are most consistent?"
--
--   3. lib_attribute_coverage()
--      Data-health view — how many ads are missing each attribute.
--      Surfaced as a pill on the Insights page.
--
-- Apply via supabase db push.

BEGIN;

-- ─── 1. Two-attribute heatmap ────────────────────────────────────────
DROP FUNCTION IF EXISTS public.lib_perf_heatmap(TEXT, TEXT, DATE, DATE) CASCADE;

CREATE OR REPLACE FUNCTION public.lib_perf_heatmap(
  attr_a TEXT, attr_b TEXT, since DATE, until DATE
)
RETURNS TABLE (
  value_a          TEXT,
  value_b          TEXT,
  ads_count        BIGINT,
  spend            NUMERIC,
  booked           BIGINT,
  closes           BIGINT,
  cost_per_booked  NUMERIC,
  winners          BIGINT
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  allowed TEXT[] := ARRAY[
    'hook_type','message_frame','mechanism_reveal','proof_character',
    'pain_angle','funnel_stage','awareness_level','length_bucket',
    'format','actor','vertical','offer_slug'
  ];
BEGIN
  IF NOT (attr_a = ANY(allowed)) THEN
    RAISE EXCEPTION 'lib_perf_heatmap: unsupported attr_a "%"', attr_a;
  END IF;
  IF NOT (attr_b = ANY(allowed)) THEN
    RAISE EXCEPTION 'lib_perf_heatmap: unsupported attr_b "%"', attr_b;
  END IF;
  IF attr_a = attr_b THEN
    RAISE EXCEPTION 'lib_perf_heatmap: attr_a and attr_b must differ';
  END IF;

  RETURN QUERY EXECUTE format($f$
    SELECT
      %1$I AS value_a,
      %2$I AS value_b,
      COUNT(*)                                       AS ads_count,
      COALESCE(SUM(spend),  0)                       AS spend,
      COALESCE(SUM(booked), 0)                       AS booked,
      COALESCE(SUM(closes), 0)                       AS closes,
      CASE WHEN SUM(booked) > 0 THEN SUM(spend)::numeric / SUM(booked) END AS cost_per_booked,
      COUNT(*) FILTER (WHERE effective_winner)       AS winners
    FROM public.lib_ad_performance(%3$L::date, %4$L::date)
    WHERE %1$I IS NOT NULL AND %2$I IS NOT NULL
    GROUP BY %1$I, %2$I
    ORDER BY booked DESC NULLS LAST
  $f$, attr_a, attr_b, since, until);
END;
$$;

GRANT EXECUTE ON FUNCTION public.lib_perf_heatmap(TEXT, TEXT, DATE, DATE) TO anon, authenticated;


-- ─── 2. Most consistent winning attributes ───────────────────────────
-- For each (attribute_name, attribute_value) appearing in 2+ winners,
-- report: winners count, total spend across those winners, average
-- cost-per-booked-call across them.
--
-- This is what surfaces in the Insights page as "most consistent
-- winning attributes."
DROP FUNCTION IF EXISTS public.lib_winning_attributes(DATE, DATE) CASCADE;

CREATE OR REPLACE FUNCTION public.lib_winning_attributes(since DATE, until DATE)
RETURNS TABLE (
  attribute_name    TEXT,
  attribute_value   TEXT,
  winners           BIGINT,
  total_winners    BIGINT,
  winner_share      NUMERIC,    -- winners / total_winners (0..1)
  avg_cost_per_booked NUMERIC,
  total_spend       NUMERIC,
  total_booked      BIGINT,
  total_closes      BIGINT
)
LANGUAGE SQL STABLE AS $$
  WITH winners AS (
    SELECT * FROM public.lib_ad_performance(since, until) WHERE effective_winner
  ),
  total AS (
    SELECT COUNT(*)::bigint AS n FROM winners
  ),
  per_attr AS (
    SELECT 'hook_type'::text        AS attribute_name, hook_type        AS attribute_value, spend, booked, closes, cost_per_booked FROM winners WHERE hook_type IS NOT NULL
    UNION ALL
    SELECT 'message_frame',          message_frame,     spend, booked, closes, cost_per_booked FROM winners WHERE message_frame IS NOT NULL
    UNION ALL
    SELECT 'mechanism_reveal',       mechanism_reveal,  spend, booked, closes, cost_per_booked FROM winners WHERE mechanism_reveal IS NOT NULL
    UNION ALL
    SELECT 'proof_character',        proof_character,   spend, booked, closes, cost_per_booked FROM winners WHERE proof_character IS NOT NULL
    UNION ALL
    SELECT 'pain_angle',             pain_angle,        spend, booked, closes, cost_per_booked FROM winners WHERE pain_angle IS NOT NULL
    UNION ALL
    SELECT 'funnel_stage',           funnel_stage,      spend, booked, closes, cost_per_booked FROM winners WHERE funnel_stage IS NOT NULL
    UNION ALL
    SELECT 'awareness_level',        awareness_level,   spend, booked, closes, cost_per_booked FROM winners WHERE awareness_level IS NOT NULL
    UNION ALL
    SELECT 'length_bucket',          length_bucket,     spend, booked, closes, cost_per_booked FROM winners WHERE length_bucket IS NOT NULL
    UNION ALL
    SELECT 'format',                 format,            spend, booked, closes, cost_per_booked FROM winners WHERE format IS NOT NULL
    UNION ALL
    SELECT 'actor',                  actor,             spend, booked, closes, cost_per_booked FROM winners WHERE actor IS NOT NULL
    UNION ALL
    SELECT 'vertical',               vertical,          spend, booked, closes, cost_per_booked FROM winners WHERE vertical IS NOT NULL
  )
  SELECT
    pa.attribute_name,
    pa.attribute_value,
    COUNT(*)::bigint            AS winners,
    t.n                          AS total_winners,
    (COUNT(*)::numeric / NULLIF(t.n, 0)) AS winner_share,
    AVG(pa.cost_per_booked)::numeric AS avg_cost_per_booked,
    SUM(pa.spend)::numeric           AS total_spend,
    SUM(pa.booked)::bigint           AS total_booked,
    SUM(pa.closes)::bigint           AS total_closes
  FROM per_attr pa
  CROSS JOIN total t
  GROUP BY pa.attribute_name, pa.attribute_value, t.n
  HAVING COUNT(*) >= 2  -- "consistent" = appears in 2+ winners
  ORDER BY COUNT(*) DESC, AVG(pa.cost_per_booked) ASC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.lib_winning_attributes(DATE, DATE) TO anon, authenticated;


-- ─── 3. Coverage / data-health view ──────────────────────────────────
-- How many ads have each attribute populated. Surfaced as a pill on
-- Insights ("9/10 attributes covered across 84% of ads").
DROP VIEW IF EXISTS public.lib_attribute_coverage CASCADE;
CREATE VIEW public.lib_attribute_coverage AS
WITH total AS (SELECT COUNT(*)::bigint AS n FROM public.ads)
SELECT 'hook_type'::text        AS attribute_name, COUNT(hook_type)        AS covered, t.n AS total, (COUNT(hook_type)::numeric        / NULLIF(t.n, 0))::numeric(5,4) AS coverage_pct FROM public.creative_attributes, total t GROUP BY t.n
UNION ALL SELECT 'message_frame',     COUNT(message_frame),     t.n, (COUNT(message_frame)::numeric     / NULLIF(t.n, 0))::numeric(5,4) FROM public.creative_attributes, total t GROUP BY t.n
UNION ALL SELECT 'mechanism_reveal',  COUNT(mechanism_reveal),  t.n, (COUNT(mechanism_reveal)::numeric  / NULLIF(t.n, 0))::numeric(5,4) FROM public.creative_attributes, total t GROUP BY t.n
UNION ALL SELECT 'proof_character',   COUNT(proof_character),   t.n, (COUNT(proof_character)::numeric   / NULLIF(t.n, 0))::numeric(5,4) FROM public.creative_attributes, total t GROUP BY t.n
UNION ALL SELECT 'pain_angle',        COUNT(pain_angle),        t.n, (COUNT(pain_angle)::numeric        / NULLIF(t.n, 0))::numeric(5,4) FROM public.creative_attributes, total t GROUP BY t.n
UNION ALL SELECT 'funnel_stage',      COUNT(funnel_stage),      t.n, (COUNT(funnel_stage)::numeric      / NULLIF(t.n, 0))::numeric(5,4) FROM public.creative_attributes, total t GROUP BY t.n
UNION ALL SELECT 'awareness_level',   COUNT(awareness_level),   t.n, (COUNT(awareness_level)::numeric   / NULLIF(t.n, 0))::numeric(5,4) FROM public.creative_attributes, total t GROUP BY t.n
UNION ALL SELECT 'length_bucket',     COUNT(length_bucket),     t.n, (COUNT(length_bucket)::numeric     / NULLIF(t.n, 0))::numeric(5,4) FROM public.creative_attributes, total t GROUP BY t.n
UNION ALL SELECT 'format',            COUNT(format),            t.n, (COUNT(format)::numeric            / NULLIF(t.n, 0))::numeric(5,4) FROM public.creative_attributes, total t GROUP BY t.n
UNION ALL SELECT 'actor',             COUNT(actor),             t.n, (COUNT(actor)::numeric             / NULLIF(t.n, 0))::numeric(5,4) FROM public.creative_attributes, total t GROUP BY t.n
UNION ALL SELECT 'vertical',          COUNT(vertical),          t.n, (COUNT(vertical)::numeric          / NULLIF(t.n, 0))::numeric(5,4) FROM public.creative_attributes, total t GROUP BY t.n;

GRANT SELECT ON public.lib_attribute_coverage TO anon, authenticated;


-- ─── 4. Helper: ads needing extraction ──────────────────────────────
-- Used by the creative-tag-ad Edge Function in mode='missing' and by
-- the Insights page "Tag missing ads" button. Returns ad_ids that
-- don't have a creative_attributes row OR have one but extracted_at
-- is NULL.
DROP VIEW IF EXISTS public.lib_ads_needing_extraction CASCADE;
CREATE VIEW public.lib_ads_needing_extraction AS
SELECT
  a.ad_id,
  a.ad_name,
  a.campaign_name,
  a.adset_name
FROM public.ads a
LEFT JOIN public.creative_attributes ca ON ca.ad_id = a.ad_id
WHERE ca.extracted_at IS NULL
ORDER BY a.ad_id DESC;

GRANT SELECT ON public.lib_ads_needing_extraction TO anon, authenticated;


NOTIFY pgrst, 'reload schema';

COMMIT;
