-- Per-typeform-response override layer (Ben 2026-05-31).
--
-- Coverage report showed 68/157 typeform rows with no ad_id resolved AND
-- no easy way to manually classify them. Ben needs to be able to:
--   1. Tag any unresolved row with an audience slug ("restoration",
--      "electrician", "accounting", or a new one he types)
--   2. Optionally pin it to a specific ad_id when he knows which ad it came
--      from (e.g. utm_campaign + utm_content clearly identify it)
--   3. Bulk-classify by utm_campaign pattern — most SCIO campaign names
--      already contain "Restoration" or "Electricians".
--
-- This table is the per-row override layer. It composes with the existing
-- campaign-level override table (migration 110) — response-level beats
-- campaign-level beats name parser beats null.

BEGIN;

CREATE TABLE IF NOT EXISTS public.typeform_response_overrides (
  response_id     TEXT PRIMARY KEY REFERENCES public.typeform_responses(response_id) ON DELETE CASCADE,
  audience_slug   TEXT NOT NULL,
  ad_id           TEXT,
  notes           TEXT,
  set_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  set_by_user_id  UUID
);

CREATE INDEX IF NOT EXISTS idx_typeform_response_overrides_audience
  ON public.typeform_response_overrides (audience_slug);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.typeform_response_overrides TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.typeform_response_overrides TO anon;

-- ───────────────────────────────────────────────────────────────────────────
-- View: lib_typeform_audience_resolved
-- One row per typeform_responses. Resolves audience_slug via the priority:
--   1. response-level override (typeform_response_overrides)
--   2. campaign-level override (campaign_audience_overrides) — keyed by
--      utm_campaign value, since typeform stores the campaign NAME not ID
--   3. parser on utm_campaign string
--   4. NULL
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.lib_typeform_audience_resolved AS
SELECT
  tr.response_id,
  COALESCE(
    ro.audience_slug,                                -- per-response override
    co.audience_slug,                                -- per-campaign override
    CASE                                             -- parser fallback
      WHEN tr.utm_campaign ILIKE '%restoration%'                            THEN 'restoration'
      WHEN tr.utm_campaign ILIKE '%electrician%'                            THEN 'electrician'
      WHEN tr.utm_campaign ILIKE '%accounting%' OR tr.utm_campaign ILIKE '%bookkeep%' THEN 'accounting'
      WHEN tr.utm_campaign ILIKE '%pool%'                                   THEN 'pool_builders'
      WHEN tr.utm_campaign ILIKE '%real estate%' OR tr.utm_campaign ILIKE '%realtor%' THEN 'real_estate'
      WHEN tr.utm_campaign ILIKE '%roofing%' OR tr.utm_campaign ILIKE '%roofer%' THEN 'roofing'
      WHEN tr.utm_campaign ILIKE '%plumb%'                                  THEN 'plumbing'
      WHEN tr.utm_campaign ILIKE '%hvac%'                                   THEN 'hvac'
      ELSE NULL
    END
  )::text AS audience_slug,
  CASE
    WHEN ro.response_id IS NOT NULL                  THEN 'response_override'
    WHEN co.campaign_id IS NOT NULL                  THEN 'campaign_override'
    WHEN tr.utm_campaign IS NOT NULL                 THEN 'parsed'
    ELSE 'unknown'
  END AS audience_source,
  COALESCE(ro.ad_id, tr.ad_id) AS ad_id
FROM public.typeform_responses tr
LEFT JOIN public.typeform_response_overrides ro ON ro.response_id = tr.response_id
LEFT JOIN public.campaign_audience_overrides co ON co.campaign_id = tr.utm_campaign;

GRANT SELECT ON public.lib_typeform_audience_resolved TO anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Replace lib_attribution_unresolved_typeform — adds the current audience
-- (override or parser), the override state, and an "is_classified" flag so
-- the page can show rows-with-audience differently from truly-unknown rows.
--
-- Need DROP+CREATE (not REPLACE) because column order/names changed from
-- migration 111.
-- ───────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.lib_attribution_unresolved_typeform;

CREATE VIEW public.lib_attribution_unresolved_typeform AS
SELECT
  tr.response_id,
  tr.submitted_at,
  tr.email,
  tr.first_name,
  tr.last_name,
  tr.form_name,
  tr.utm_source,
  tr.utm_medium,
  tr.utm_campaign,
  tr.utm_term,
  tr.utm_content,
  tr.qualified,
  tr.revenue_tier,
  -- Override fields (NULL if no override exists)
  ro.audience_slug AS override_audience_slug,
  ro.ad_id        AS override_ad_id,
  ro.notes        AS override_notes,
  ro.set_at       AS override_set_at,
  -- Currently-resolved audience (response_override → campaign_override → parser)
  resolved.audience_slug AS current_audience_slug,
  resolved.audience_source,
  -- True if audience has been set by any means (override or parser)
  (resolved.audience_slug IS NOT NULL) AS is_classified,
  CASE
    WHEN tr.utm_campaign IS NULL AND tr.utm_content IS NULL THEN 'no_utms_at_all'
    WHEN tr.utm_content ~ '^[0-9]{10,}$'                  THEN 'looks_like_ad_id_but_no_match'
    WHEN tr.utm_content IS NOT NULL                       THEN 'utm_content_is_creative_name'
    WHEN tr.utm_campaign LIKE '%test%'                    THEN 'test_traffic'
    ELSE 'other'
  END AS likely_cause
FROM public.typeform_responses tr
LEFT JOIN public.typeform_response_overrides ro ON ro.response_id = tr.response_id
LEFT JOIN public.lib_typeform_audience_resolved resolved ON resolved.response_id = tr.response_id
WHERE tr.ad_id IS NULL
  AND tr.submitted_at >= NOW() - INTERVAL '90 days'
ORDER BY tr.submitted_at DESC;

GRANT SELECT ON public.lib_attribution_unresolved_typeform TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
