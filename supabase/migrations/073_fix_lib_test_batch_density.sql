-- 073_fix_lib_test_batch_density.sql
--
-- Fix the empty-batch crash in lib_test_batch_density:
--   "field name must not be null"
--
-- Root cause: jsonb_object_agg(key, value) rejects NULL keys. When a batch
-- has no scripts (or scripts with NULL target_attributes), the FILTER on
-- the value count doesn't prevent NULL keys from reaching the aggregator.
-- The fix: filter on the KEY being non-null in each aggregator, and drop
-- the proof_character density (removed from the 5-attr trim 2026-05-18).

BEGIN;

-- Drop first because we're renaming the trailing column (proof_density →
-- awareness_density), which CREATE OR REPLACE VIEW cannot do.
DROP VIEW IF EXISTS public.lib_test_batch_density;

CREATE VIEW public.lib_test_batch_density AS
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
  COUNT(s.id) AS script_count,
  COUNT(s.ad_id) FILTER (WHERE s.ad_id IS NOT NULL) AS linked_count,
  COALESCE(
    jsonb_object_agg(s.target_attributes->>'hook_type', hcount.n)
      FILTER (WHERE s.target_attributes->>'hook_type' IS NOT NULL),
    '{}'::jsonb
  ) AS hook_density,
  COALESCE(
    jsonb_object_agg(s.target_attributes->>'message_frame', fcount.n)
      FILTER (WHERE s.target_attributes->>'message_frame' IS NOT NULL),
    '{}'::jsonb
  ) AS frame_density,
  COALESCE(
    jsonb_object_agg(s.target_attributes->>'mechanism_reveal', mcount.n)
      FILTER (WHERE s.target_attributes->>'mechanism_reveal' IS NOT NULL),
    '{}'::jsonb
  ) AS mech_density,
  COALESCE(
    jsonb_object_agg(s.target_attributes->>'pain_angle', pcount.n)
      FILTER (WHERE s.target_attributes->>'pain_angle' IS NOT NULL),
    '{}'::jsonb
  ) AS pain_density,
  COALESCE(
    jsonb_object_agg(s.target_attributes->>'awareness_level', acount.n)
      FILTER (WHERE s.target_attributes->>'awareness_level' IS NOT NULL),
    '{}'::jsonb
  ) AS awareness_density
FROM public.test_batches b
LEFT JOIN public.generated_scripts s ON s.test_batch_id = b.id
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS n
  FROM public.generated_scripts s2
  WHERE s2.test_batch_id = b.id
    AND s2.target_attributes->>'hook_type' = s.target_attributes->>'hook_type'
) hcount ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS n
  FROM public.generated_scripts s2
  WHERE s2.test_batch_id = b.id
    AND s2.target_attributes->>'message_frame' = s.target_attributes->>'message_frame'
) fcount ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS n
  FROM public.generated_scripts s2
  WHERE s2.test_batch_id = b.id
    AND s2.target_attributes->>'mechanism_reveal' = s.target_attributes->>'mechanism_reveal'
) mcount ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS n
  FROM public.generated_scripts s2
  WHERE s2.test_batch_id = b.id
    AND s2.target_attributes->>'pain_angle' = s.target_attributes->>'pain_angle'
) pcount ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS n
  FROM public.generated_scripts s2
  WHERE s2.test_batch_id = b.id
    AND s2.target_attributes->>'awareness_level' = s.target_attributes->>'awareness_level'
) acount ON true
GROUP BY b.id;

GRANT SELECT ON public.lib_test_batch_density TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
