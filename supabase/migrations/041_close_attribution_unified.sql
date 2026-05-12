-- 041_close_attribution_unified.sql
-- Close attribution was undercounting. Symptom: dashboard CAC for last 30
-- days reported "1 close" but the closer EOD table had 4 (George Sidhom,
-- Shain Mann, Jeff Stovall, Joseph Guaracino). Only George came through
-- the Typeform funnel; the other 3 were direct/HYROS-tracked.
--
-- Root cause: lib_typeform_*_attribution views derived closes solely from
-- typeform_responses joined to closer_calls/ghl_appointments. Prospects
-- who never filled the form (cold outreach, old-funnel re-engagement,
-- HYROS-only attribution chains) had zero close credit anywhere.
--
-- Fix: a 3-tier attribution resolver runs against every closed closer_call:
--   1. Typeform match (first + last name → typeform_responses.ad_id)
--   2. HYROS match  (first + last name → hyros_events.meta_ad_id)
--   3. Otherwise: ad_id NULL → counted in lib_orphan_closes for visibility.
--
-- Three rollup views per level (ad / adset / campaign) then aggregate the
-- closes + revenue + cash. AdsPerformance.jsx reads from these for the
-- close/CAC columns alongside the typeform views.
--
-- Idempotent. Apply via supabase db push.

BEGIN;

-- Strip the " - …Strategy Call" / " - …Intro Call" suffix the closers
-- often append to prospect_name. Returns just the human name.
CREATE OR REPLACE FUNCTION public.strip_call_suffix(p TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT trim(regexp_replace(COALESCE(p,''), '\s*-\s*.*$', ''))
$$;

CREATE OR REPLACE FUNCTION public.name_first_token(p TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(trim(split_part(COALESCE(p,''), ' ', 1)))
$$;

CREATE OR REPLACE FUNCTION public.name_second_token(p TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(trim(split_part(COALESCE(p,''), ' ', 2)))
$$;

-- ─── Resolver: per closed closer_call, pick the best ad attribution ────
DROP VIEW IF EXISTS public.lib_close_resolved CASCADE;
CREATE VIEW public.lib_close_resolved AS
WITH closed AS (
  SELECT
    c.id            AS closer_call_id,
    c.prospect_name,
    public.strip_call_suffix(c.prospect_name) AS clean_name,
    c.revenue,
    c.cash_collected,
    c.created_at
  FROM public.closer_calls c
  WHERE c.outcome = 'closed'
),
typeform_match AS (
  SELECT
    cd.closer_call_id,
    (
      SELECT tfr.ad_id
      FROM public.typeform_responses tfr
      WHERE tfr.ad_id IS NOT NULL
        AND public.name_first_token(tfr.first_name) = public.name_first_token(cd.clean_name)
        AND (
          public.name_second_token(cd.clean_name) = ''
          OR lower(coalesce(tfr.last_name, tfr.first_name, '')) ILIKE '%' || public.name_second_token(cd.clean_name) || '%'
        )
      ORDER BY tfr.submitted_at DESC NULLS LAST
      LIMIT 1
    ) AS ad_id,
    (
      SELECT tfr.utm_term
      FROM public.typeform_responses tfr
      WHERE tfr.utm_term IS NOT NULL
        AND public.name_first_token(tfr.first_name) = public.name_first_token(cd.clean_name)
        AND (
          public.name_second_token(cd.clean_name) = ''
          OR lower(coalesce(tfr.last_name, tfr.first_name, '')) ILIKE '%' || public.name_second_token(cd.clean_name) || '%'
        )
      ORDER BY tfr.submitted_at DESC NULLS LAST
      LIMIT 1
    ) AS adset_id,
    (
      SELECT tfr.utm_campaign
      FROM public.typeform_responses tfr
      WHERE tfr.utm_campaign IS NOT NULL
        AND public.name_first_token(tfr.first_name) = public.name_first_token(cd.clean_name)
        AND (
          public.name_second_token(cd.clean_name) = ''
          OR lower(coalesce(tfr.last_name, tfr.first_name, '')) ILIKE '%' || public.name_second_token(cd.clean_name) || '%'
        )
      ORDER BY tfr.submitted_at DESC NULLS LAST
      LIMIT 1
    ) AS utm_campaign
  FROM closed cd
),
hyros_match AS (
  SELECT
    cd.closer_call_id,
    (
      SELECT h.meta_ad_id
      FROM public.hyros_events h
      WHERE h.meta_ad_id IS NOT NULL
        AND public.name_first_token(h.first_name) = public.name_first_token(cd.clean_name)
        AND (
          public.name_second_token(cd.clean_name) = ''
          OR lower(coalesce(h.last_name,'')) ILIKE public.name_second_token(cd.clean_name) || '%'
        )
      ORDER BY h.event_date DESC
      LIMIT 1
    ) AS ad_id,
    (
      SELECT h.campaign_name
      FROM public.hyros_events h
      WHERE h.campaign_name IS NOT NULL
        AND public.name_first_token(h.first_name) = public.name_first_token(cd.clean_name)
        AND (
          public.name_second_token(cd.clean_name) = ''
          OR lower(coalesce(h.last_name,'')) ILIKE public.name_second_token(cd.clean_name) || '%'
        )
      ORDER BY h.event_date DESC
      LIMIT 1
    ) AS campaign_name
  FROM closed cd
)
SELECT
  cd.closer_call_id,
  cd.prospect_name,
  cd.clean_name,
  cd.revenue,
  cd.cash_collected,
  cd.created_at,
  -- Tier 1 wins; tier 2 fills the gap; null if neither has a match.
  COALESCE(tm.ad_id,                                                                                a.ad_id)        AS resolved_ad_id,
  COALESCE(tm.adset_id,                                                                             a.adset_id)     AS resolved_adset_id,
  COALESCE(tm.utm_campaign, hm.campaign_name, a.campaign_name)                                                       AS resolved_campaign,
  CASE
    WHEN tm.ad_id IS NOT NULL OR tm.adset_id IS NOT NULL OR tm.utm_campaign IS NOT NULL THEN 'typeform'
    WHEN hm.ad_id IS NOT NULL OR hm.campaign_name IS NOT NULL                            THEN 'hyros'
    ELSE 'orphan'
  END AS attribution_source
FROM closed cd
LEFT JOIN typeform_match tm ON tm.closer_call_id = cd.closer_call_id
LEFT JOIN hyros_match    hm ON hm.closer_call_id = cd.closer_call_id
-- Resolve ad context (campaign + adset) from ads when HYROS provides the meta_ad_id.
LEFT JOIN LATERAL (
  SELECT a.ad_id, a.adset_id, a.campaign_name
  FROM public.ads a
  WHERE a.ad_id = hm.ad_id
  LIMIT 1
) a ON true;

GRANT SELECT ON public.lib_close_resolved TO anon, authenticated;

-- ─── Per-ad close rollup ───────────────────────────────────────────
DROP VIEW IF EXISTS public.lib_close_per_ad CASCADE;
CREATE VIEW public.lib_close_per_ad AS
SELECT
  resolved_ad_id AS ad_id,
  count(*)                            AS closes,
  COALESCE(sum(revenue), 0)           AS revenue,
  COALESCE(sum(cash_collected), 0)    AS cash,
  max(created_at)                     AS last_close_at
FROM public.lib_close_resolved
WHERE resolved_ad_id IS NOT NULL
GROUP BY resolved_ad_id;
GRANT SELECT ON public.lib_close_per_ad TO anon, authenticated;

-- ─── Per-adset close rollup ────────────────────────────────────────
DROP VIEW IF EXISTS public.lib_close_per_adset CASCADE;
CREATE VIEW public.lib_close_per_adset AS
SELECT
  resolved_adset_id AS adset_id,
  count(*)                            AS closes,
  COALESCE(sum(revenue), 0)           AS revenue,
  COALESCE(sum(cash_collected), 0)    AS cash,
  max(created_at)                     AS last_close_at
FROM public.lib_close_resolved
WHERE resolved_adset_id IS NOT NULL
GROUP BY resolved_adset_id;
GRANT SELECT ON public.lib_close_per_adset TO anon, authenticated;

-- ─── Per-campaign close rollup ─────────────────────────────────────
DROP VIEW IF EXISTS public.lib_close_per_campaign CASCADE;
CREATE VIEW public.lib_close_per_campaign AS
SELECT
  resolved_campaign AS utm_campaign,
  count(*)                            AS closes,
  COALESCE(sum(revenue), 0)           AS revenue,
  COALESCE(sum(cash_collected), 0)    AS cash,
  max(created_at)                     AS last_close_at
FROM public.lib_close_resolved
WHERE resolved_campaign IS NOT NULL
GROUP BY resolved_campaign;
GRANT SELECT ON public.lib_close_per_campaign TO anon, authenticated;

-- ─── Orphan closes (visible to operator so they can be claimed) ────
DROP VIEW IF EXISTS public.lib_orphan_closes CASCADE;
CREATE VIEW public.lib_orphan_closes AS
SELECT
  closer_call_id,
  prospect_name,
  clean_name,
  revenue,
  cash_collected,
  created_at
FROM public.lib_close_resolved
WHERE attribution_source = 'orphan'
ORDER BY created_at DESC;
GRANT SELECT ON public.lib_orphan_closes TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
