-- Ad kanban — the per-ad view Ben asked for (2026-05-31).
--
-- The per-lead and per-creative-cluster triage queues missed the point.
-- Ben thinks at the AD level: he wants to see his top-spending ads, see
-- their current audience, and bulk-reassign by dragging. Classifying one
-- ad propagates to every current + future lead from it automatically.
--
-- This view powers the kanban. Source-of-truth for the audience override
-- is creative_attributes.vertical (existing column, already used by the
-- ad library). Falls back to a campaign-name parser when no override.
--
-- Only includes ads with spend in the last 30d so the board isn't
-- polluted by old/never-activated drafts. Sort by spend DESC so the
-- biggest leaks sit at the top of each column.

BEGIN;

CREATE OR REPLACE VIEW public.lib_attribution_ad_kanban AS
WITH spend_30d AS (
  SELECT ad_id, COALESCE(SUM(spend), 0)::numeric AS spend
  FROM public.ad_daily_stats
  WHERE date >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY 1
),
leads_30d AS (
  SELECT ad_id, COUNT(*)::int AS leads
  FROM public.typeform_responses
  WHERE ad_id IS NOT NULL
    AND submitted_at >= NOW() - INTERVAL '30 days'
  GROUP BY 1
)
SELECT
  a.ad_id,
  a.ad_name,
  a.campaign_name,
  a.adset_name,
  a.effective_status,
  a.thumbnail_url,
  a.asset_url,
  a.asset_type,
  a.destination_url,
  COALESCE(s.spend, 0) AS spend_30d,
  COALESCE(l.leads, 0) AS leads_30d,
  CASE
    WHEN COALESCE(l.leads, 0) > 0
      THEN ROUND(COALESCE(s.spend, 0) / l.leads, 2)
    ELSE NULL
  END AS cpl_30d,
  -- Resolved vertical: creative_attributes.vertical wins; else parser; else null.
  COALESCE(
    ca.vertical,
    CASE
      WHEN a.campaign_name ILIKE '%restoration%'                                THEN 'restoration'
      WHEN a.campaign_name ILIKE '%electrician%'                                THEN 'electrician'
      WHEN a.campaign_name ILIKE '%accounting%' OR a.campaign_name ILIKE '%bookkeep%' THEN 'accounting'
      WHEN a.campaign_name ILIKE '%pool%'                                       THEN 'pool_builders'
      WHEN a.campaign_name ILIKE '%real estate%' OR a.campaign_name ILIKE '%realtor%' THEN 'real_estate'
      WHEN a.campaign_name ILIKE '%roofing%' OR a.campaign_name ILIKE '%roofer%' THEN 'roofing'
      WHEN a.campaign_name ILIKE '%plumb%'                                      THEN 'plumbing'
      WHEN a.campaign_name ILIKE '%hvac%'                                       THEN 'hvac'
      ELSE NULL
    END
  ) AS current_vertical,
  CASE
    WHEN ca.vertical IS NOT NULL          THEN 'override'
    WHEN a.campaign_name IS NOT NULL      THEN 'parsed'
    ELSE                                       'unknown'
  END AS vertical_source,
  ca.offer_slug,
  ca.vertical AS override_vertical   -- separate column so the UI can tell
                                     -- override vs parser at a glance
FROM public.ads a
INNER JOIN spend_30d s ON s.ad_id = a.ad_id
LEFT  JOIN leads_30d l ON l.ad_id = a.ad_id
LEFT  JOIN public.creative_attributes ca ON ca.ad_id = a.ad_id
WHERE s.spend > 0
ORDER BY s.spend DESC;

GRANT SELECT ON public.lib_attribution_ad_kanban TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
