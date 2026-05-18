-- 074_test_batch_density_cte.sql
--
-- Rewrites lib_test_batch_density from per-row lateral joins to a single
-- pre-aggregation CTE. The previous version (migration 073) did 5 lateral
-- subqueries per script row, each scanning all scripts in the same batch
-- — O(N²) per batch on every refresh. Once Ben has 10+ active batches
-- with 20-30 scripts each, that's tens of thousands of row scans per
-- Insights/Tests page load.
--
-- New shape:
--   counts CTE — one pass: GROUP BY batch_id, attribute, value
--   pivot CTE — one row per batch, jsonb_object_agg of (value → count) per attribute
--   final SELECT — join batches LEFT JOIN pivot
--
-- Result: O(N) per batch, single table scan of generated_scripts.

BEGIN;

DROP VIEW IF EXISTS public.lib_test_batch_density;

CREATE VIEW public.lib_test_batch_density AS
WITH counts AS (
  SELECT
    s.test_batch_id,
    s.target_attributes->>'hook_type'        AS hook_v,
    s.target_attributes->>'message_frame'    AS frame_v,
    s.target_attributes->>'mechanism_reveal' AS mech_v,
    s.target_attributes->>'pain_angle'       AS pain_v,
    s.target_attributes->>'awareness_level'  AS aware_v
  FROM public.generated_scripts s
  WHERE s.test_batch_id IS NOT NULL
),
hook_counts AS (
  SELECT test_batch_id, hook_v AS v, COUNT(*)::INT AS n
  FROM counts WHERE hook_v IS NOT NULL
  GROUP BY test_batch_id, hook_v
),
frame_counts AS (
  SELECT test_batch_id, frame_v AS v, COUNT(*)::INT AS n
  FROM counts WHERE frame_v IS NOT NULL
  GROUP BY test_batch_id, frame_v
),
mech_counts AS (
  SELECT test_batch_id, mech_v AS v, COUNT(*)::INT AS n
  FROM counts WHERE mech_v IS NOT NULL
  GROUP BY test_batch_id, mech_v
),
pain_counts AS (
  SELECT test_batch_id, pain_v AS v, COUNT(*)::INT AS n
  FROM counts WHERE pain_v IS NOT NULL
  GROUP BY test_batch_id, pain_v
),
aware_counts AS (
  SELECT test_batch_id, aware_v AS v, COUNT(*)::INT AS n
  FROM counts WHERE aware_v IS NOT NULL
  GROUP BY test_batch_id, aware_v
),
pivot AS (
  SELECT
    b.id AS batch_id,
    COALESCE((SELECT jsonb_object_agg(v, n) FROM hook_counts  WHERE test_batch_id = b.id), '{}'::jsonb) AS hook_density,
    COALESCE((SELECT jsonb_object_agg(v, n) FROM frame_counts WHERE test_batch_id = b.id), '{}'::jsonb) AS frame_density,
    COALESCE((SELECT jsonb_object_agg(v, n) FROM mech_counts  WHERE test_batch_id = b.id), '{}'::jsonb) AS mech_density,
    COALESCE((SELECT jsonb_object_agg(v, n) FROM pain_counts  WHERE test_batch_id = b.id), '{}'::jsonb) AS pain_density,
    COALESCE((SELECT jsonb_object_agg(v, n) FROM aware_counts WHERE test_batch_id = b.id), '{}'::jsonb) AS awareness_density
  FROM public.test_batches b
),
totals AS (
  SELECT
    test_batch_id,
    COUNT(*)::INT                                    AS script_count,
    COUNT(*) FILTER (WHERE ad_id IS NOT NULL)::INT   AS linked_count
  FROM public.generated_scripts
  WHERE test_batch_id IS NOT NULL
  GROUP BY test_batch_id
)
SELECT
  b.id,
  b.name,
  b.slug,
  b.hypothesis,
  b.notes,
  b.offer_slug,
  b.created_at,
  b.launched_at,
  b.closed_at,
  b.campaign_names,
  b.created_by,
  b.updated_at,
  COALESCE(t.script_count, 0) AS script_count,
  COALESCE(t.linked_count, 0) AS linked_count,
  p.hook_density,
  p.frame_density,
  p.mech_density,
  p.pain_density,
  p.awareness_density
FROM public.test_batches b
LEFT JOIN totals t ON t.test_batch_id = b.id
LEFT JOIN pivot  p ON p.batch_id     = b.id;

GRANT SELECT ON public.lib_test_batch_density TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
