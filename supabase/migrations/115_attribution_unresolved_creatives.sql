-- Group unresolved typeform rows by creative (Ben 2026-05-31).
--
-- The per-lead triage queue was unworkable: 12 leads behind "Tan typography"
-- meant 12 clicks. Pivoting to one-card-per-creative with a thumbnail so
-- Ben can SEE the ad and bulk-classify multiple at once.
--
-- Key match: `ads` table is keyed on Meta numeric ad_id but the typeform
-- rows carry utm_content = creative description (e.g. "Tan typography").
-- We match by exact-case ad_name = utm_content, then by ILIKE if exact
-- fails. campaign_name is the secondary key for disambiguation.

BEGIN;

CREATE OR REPLACE VIEW public.lib_attribution_unresolved_creatives AS
WITH unresolved AS (
  SELECT
    response_id,
    submitted_at,
    email,
    first_name,
    last_name,
    utm_campaign,
    utm_content,
    utm_term,
    utm_source,
    utm_medium
  FROM public.typeform_responses
  WHERE ad_id IS NULL
    AND submitted_at >= NOW() - INTERVAL '90 days'
),
groups AS (
  SELECT
    COALESCE(utm_campaign, '<no_campaign>') AS utm_campaign,
    COALESCE(utm_content, '<no_content>')   AS utm_content,
    COUNT(*)                                  AS leads_count,
    MIN(submitted_at)                         AS first_seen,
    MAX(submitted_at)                         AS last_seen,
    ARRAY_AGG(response_id ORDER BY submitted_at DESC) AS response_ids,
    ARRAY_AGG(email      ORDER BY submitted_at DESC) FILTER (WHERE email IS NOT NULL) AS sample_emails
  FROM unresolved
  GROUP BY 1, 2
),
-- Find the best matching ad in `ads`. Prefer exact ad_name match; fall back
-- to ILIKE (case-insensitive). Tie-break by most-recently-synced.
matched AS (
  SELECT DISTINCT ON (g.utm_campaign, g.utm_content)
    g.utm_campaign,
    g.utm_content,
    a.ad_id,
    a.ad_name,
    a.campaign_name AS ad_campaign_name,
    a.adset_name,
    a.thumbnail_url,
    a.asset_url,
    a.asset_type,
    a.effective_status,
    a.destination_url
  FROM groups g
  LEFT JOIN public.ads a
    ON (a.ad_name = g.utm_content OR a.ad_name ILIKE g.utm_content)
   AND (g.utm_campaign = '<no_campaign>' OR a.campaign_name ILIKE g.utm_campaign)
  ORDER BY g.utm_campaign, g.utm_content, a.last_synced_at DESC NULLS LAST
),
-- Audience already set on at least one lead in this group (response_override
-- or campaign_override or parser hit). NULL = ambiguous (mixed) or all-null.
group_audience AS (
  SELECT
    COALESCE(tr.utm_campaign, '<no_campaign>') AS utm_campaign,
    COALESCE(tr.utm_content, '<no_content>')   AS utm_content,
    -- If every resolved row agrees on one audience, take it. Otherwise NULL.
    CASE
      WHEN COUNT(DISTINCT resolved.audience_slug) FILTER (WHERE resolved.audience_slug IS NOT NULL) = 1
        THEN MAX(resolved.audience_slug)
      ELSE NULL
    END AS current_audience_slug,
    -- Source = strongest seen across the group
    CASE
      WHEN BOOL_OR(resolved.audience_source = 'response_override') THEN 'response_override'
      WHEN BOOL_OR(resolved.audience_source = 'campaign_override') THEN 'campaign_override'
      WHEN BOOL_OR(resolved.audience_source = 'parsed')            THEN 'parsed'
      ELSE 'unknown'
    END AS audience_source,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.typeform_response_overrides ro
      WHERE ro.response_id = tr.response_id
    )) AS overridden_count
  FROM unresolved tr
  LEFT JOIN public.lib_typeform_audience_resolved resolved
    ON resolved.response_id = tr.response_id
  GROUP BY 1, 2
)
SELECT
  g.utm_campaign,
  g.utm_content,
  g.leads_count,
  g.first_seen,
  g.last_seen,
  g.response_ids,
  g.sample_emails[1:3] AS sample_emails,
  m.ad_id,
  m.ad_name,
  m.ad_campaign_name,
  m.adset_name,
  m.thumbnail_url,
  m.asset_url,
  m.asset_type,
  m.effective_status,
  m.destination_url,
  ga.current_audience_slug,
  ga.audience_source,
  ga.overridden_count
FROM groups g
LEFT JOIN matched m
  ON m.utm_campaign = g.utm_campaign
 AND m.utm_content  = g.utm_content
LEFT JOIN group_audience ga
  ON ga.utm_campaign = g.utm_campaign
 AND ga.utm_content  = g.utm_content
ORDER BY g.leads_count DESC, g.last_seen DESC;

GRANT SELECT ON public.lib_attribution_unresolved_creatives TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
