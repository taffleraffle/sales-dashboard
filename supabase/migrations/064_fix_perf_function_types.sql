-- 064_fix_perf_function_types.sql
--
-- Fix: SUM() of BIGINT columns returns NUMERIC in Postgres, but the
-- wrapping function declared the columns as BIGINT in RETURNS TABLE.
-- That tripped the runtime check:
--   "structure of query does not match function result type"
--   "Returned type numeric does not match expected type bigint in column 4"
--
-- Two fixes per affected function:
--   1. Cast SUM(int_column)::bigint inside the inner query, OR
--   2. Change the column type in RETURNS TABLE to NUMERIC.
--
-- Going with #1 — keeps the public contract stable (clients still see bigint).
--
-- Apply via supabase db push.

BEGIN;

-- ─── lib_perf_by_attribute ───────────────────────────────────────────
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
  IF attr NOT IN ('hook_type','message_frame','mechanism_reveal','proof_character',
                  'pain_angle','funnel_stage','awareness_level','length_bucket',
                  'format','actor','vertical','offer_slug') THEN
    RAISE EXCEPTION 'lib_perf_by_attribute: unsupported attr "%"', attr;
  END IF;

  RETURN QUERY EXECUTE format($f$
    SELECT
      %1$I::text                                              AS attribute_value,
      COUNT(*)::bigint                                        AS ads_count,
      COALESCE(SUM(spend),    0)::numeric                     AS spend,
      COALESCE(SUM(leads),    0)::bigint                      AS leads,
      COALESCE(SUM(booked),   0)::bigint                      AS booked,
      COALESCE(SUM(closes),   0)::bigint                      AS closes,
      COALESCE(SUM(revenue),  0)::numeric                     AS revenue,
      CASE WHEN SUM(leads)  > 0 THEN (SUM(spend)::numeric / SUM(leads))  END AS cost_per_lead,
      CASE WHEN SUM(booked) > 0 THEN (SUM(spend)::numeric / SUM(booked)) END AS cost_per_booked,
      CASE WHEN SUM(closes) > 0 THEN (SUM(spend)::numeric / SUM(closes)) END AS cost_per_close,
      CASE WHEN SUM(booked) > 0 THEN (SUM(closes)::numeric / SUM(booked)) END AS close_rate,
      COUNT(*) FILTER (WHERE effective_winner)::bigint        AS winners
    FROM public.lib_ad_performance(%2$L::date, %3$L::date)
    WHERE %1$I IS NOT NULL
    GROUP BY %1$I
    ORDER BY booked DESC NULLS LAST, spend DESC NULLS LAST
  $f$, attr, since, until);
END;
$$;

GRANT EXECUTE ON FUNCTION public.lib_perf_by_attribute(TEXT, DATE, DATE) TO anon, authenticated;


-- ─── lib_perf_heatmap ─────────────────────────────────────────────────
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
      %1$I::text                                              AS value_a,
      %2$I::text                                              AS value_b,
      COUNT(*)::bigint                                        AS ads_count,
      COALESCE(SUM(spend),  0)::numeric                       AS spend,
      COALESCE(SUM(booked), 0)::bigint                        AS booked,
      COALESCE(SUM(closes), 0)::bigint                        AS closes,
      CASE WHEN SUM(booked) > 0 THEN (SUM(spend)::numeric / SUM(booked)) END AS cost_per_booked,
      COUNT(*) FILTER (WHERE effective_winner)::bigint        AS winners
    FROM public.lib_ad_performance(%3$L::date, %4$L::date)
    WHERE %1$I IS NOT NULL AND %2$I IS NOT NULL
    GROUP BY %1$I, %2$I
    ORDER BY booked DESC NULLS LAST
  $f$, attr_a, attr_b, since, until);
END;
$$;

GRANT EXECUTE ON FUNCTION public.lib_perf_heatmap(TEXT, TEXT, DATE, DATE) TO anon, authenticated;


-- ─── lib_winning_attributes ────────────────────────────────────────────
-- Also drops/recreates with bigint casts where needed.
DROP FUNCTION IF EXISTS public.lib_winning_attributes(DATE, DATE) CASCADE;

CREATE OR REPLACE FUNCTION public.lib_winning_attributes(since DATE, until DATE)
RETURNS TABLE (
  attribute_name      TEXT,
  attribute_value     TEXT,
  winners             BIGINT,
  total_winners       BIGINT,
  winner_share        NUMERIC,
  avg_cost_per_booked NUMERIC,
  total_spend         NUMERIC,
  total_booked        BIGINT,
  total_closes        BIGINT
)
LANGUAGE SQL STABLE AS $$
  WITH winners AS (
    SELECT * FROM public.lib_ad_performance(since, until) WHERE effective_winner
  ),
  total AS (
    SELECT COUNT(*)::bigint AS n FROM winners
  ),
  per_attr AS (
    SELECT 'hook_type'::text AS attribute_name, hook_type AS attribute_value, spend, booked, closes, cost_per_booked FROM winners WHERE hook_type IS NOT NULL
    UNION ALL SELECT 'message_frame',    message_frame,    spend, booked, closes, cost_per_booked FROM winners WHERE message_frame IS NOT NULL
    UNION ALL SELECT 'mechanism_reveal', mechanism_reveal, spend, booked, closes, cost_per_booked FROM winners WHERE mechanism_reveal IS NOT NULL
    UNION ALL SELECT 'proof_character',  proof_character,  spend, booked, closes, cost_per_booked FROM winners WHERE proof_character IS NOT NULL
    UNION ALL SELECT 'pain_angle',       pain_angle,       spend, booked, closes, cost_per_booked FROM winners WHERE pain_angle IS NOT NULL
    UNION ALL SELECT 'funnel_stage',     funnel_stage,     spend, booked, closes, cost_per_booked FROM winners WHERE funnel_stage IS NOT NULL
    UNION ALL SELECT 'awareness_level',  awareness_level,  spend, booked, closes, cost_per_booked FROM winners WHERE awareness_level IS NOT NULL
    UNION ALL SELECT 'length_bucket',    length_bucket,    spend, booked, closes, cost_per_booked FROM winners WHERE length_bucket IS NOT NULL
    UNION ALL SELECT 'format',           format,           spend, booked, closes, cost_per_booked FROM winners WHERE format IS NOT NULL
    UNION ALL SELECT 'actor',            actor,            spend, booked, closes, cost_per_booked FROM winners WHERE actor IS NOT NULL
    UNION ALL SELECT 'vertical',         vertical,         spend, booked, closes, cost_per_booked FROM winners WHERE vertical IS NOT NULL
  )
  SELECT
    pa.attribute_name,
    pa.attribute_value,
    COUNT(*)::bigint                              AS winners,
    t.n                                            AS total_winners,
    (COUNT(*)::numeric / NULLIF(t.n, 0))           AS winner_share,
    AVG(pa.cost_per_booked)::numeric               AS avg_cost_per_booked,
    SUM(pa.spend)::numeric                         AS total_spend,
    SUM(pa.booked)::bigint                         AS total_booked,
    SUM(pa.closes)::bigint                         AS total_closes
  FROM per_attr pa
  CROSS JOIN total t
  GROUP BY pa.attribute_name, pa.attribute_value, t.n
  HAVING COUNT(*) >= 2
  ORDER BY COUNT(*) DESC, AVG(pa.cost_per_booked) ASC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.lib_winning_attributes(DATE, DATE) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
