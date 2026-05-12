-- 043_close_resolver_performance.sql
-- lib_close_resolved timed out under load (1,922 ghl_contacts × 47 closed
-- closer_calls × 3 attribution tiers, each tier as a correlated subquery
-- with ILIKE wildcards = full table scan per closer_call per tier).
--
-- Rewrite using CTEs + DISTINCT ON. One join per attribution tier, picks
-- the latest match per closer_call. Uses functional indexes on first-name
-- tokens so the equality side of the join is index-eligible.
--
-- Idempotent. Apply via supabase db push.

BEGIN;

-- Functional indexes that let the new joins pull from btree instead of seq-scan.
CREATE INDEX IF NOT EXISTS ix_tfr_first_tok
  ON public.typeform_responses (public.name_first_token(first_name))
  WHERE first_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_ghlc_first_tok
  ON public.ghl_contacts (public.name_first_token(first_name))
  WHERE first_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_hyros_first_tok
  ON public.hyros_events (public.name_first_token(first_name))
  WHERE first_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_closer_calls_outcome_closed
  ON public.closer_calls (outcome)
  WHERE outcome = 'closed';

DROP VIEW IF EXISTS public.lib_close_resolved CASCADE;
CREATE VIEW public.lib_close_resolved AS
WITH closed AS (
  SELECT
    c.id AS closer_call_id,
    c.prospect_name,
    public.strip_call_suffix(c.prospect_name)                                AS clean_name,
    public.name_first_token (public.strip_call_suffix(c.prospect_name))      AS first_tok,
    public.name_second_token(public.strip_call_suffix(c.prospect_name))      AS second_tok,
    c.revenue,
    c.cash_collected,
    c.created_at
  FROM public.closer_calls c
  WHERE c.outcome = 'closed'
),
-- Each tier joins once, picks the freshest match per closer_call via DISTINCT ON.
typeform_match AS (
  SELECT DISTINCT ON (cd.closer_call_id)
    cd.closer_call_id,
    tfr.ad_id,
    tfr.utm_term     AS adset_id,
    tfr.utm_campaign
  FROM closed cd
  JOIN public.typeform_responses tfr
    ON public.name_first_token(tfr.first_name) = cd.first_tok
   AND (
        cd.second_tok = ''
     OR lower(coalesce(tfr.last_name, tfr.first_name, '')) ILIKE '%' || cd.second_tok || '%'
   )
  WHERE (tfr.ad_id IS NOT NULL OR tfr.utm_term IS NOT NULL OR tfr.utm_campaign IS NOT NULL)
  ORDER BY cd.closer_call_id, tfr.submitted_at DESC NULLS LAST
),
ghl_match AS (
  SELECT DISTINCT ON (cd.closer_call_id)
    cd.closer_call_id,
    g.last_ad_id       AS ad_id,
    g.last_adset_id    AS adset_id,
    g.last_utm_campaign AS utm_campaign
  FROM closed cd
  JOIN public.ghl_contacts g
    ON public.name_first_token(g.first_name) = cd.first_tok
   AND (
        cd.second_tok = ''
     OR lower(coalesce(g.last_name, g.full_name, '')) ILIKE '%' || cd.second_tok || '%'
   )
  WHERE (g.last_ad_id IS NOT NULL OR g.last_adset_id IS NOT NULL OR g.last_utm_campaign IS NOT NULL)
  ORDER BY cd.closer_call_id, g.date_added DESC NULLS LAST
),
hyros_match AS (
  SELECT DISTINCT ON (cd.closer_call_id)
    cd.closer_call_id,
    h.meta_ad_id      AS ad_id,
    h.campaign_name
  FROM closed cd
  JOIN public.hyros_events h
    ON public.name_first_token(h.first_name) = cd.first_tok
   AND (
        cd.second_tok = ''
     OR lower(coalesce(h.last_name, '')) ILIKE cd.second_tok || '%'
   )
  WHERE (h.meta_ad_id IS NOT NULL OR h.campaign_name IS NOT NULL)
  ORDER BY cd.closer_call_id, h.event_date DESC
)
SELECT
  cd.closer_call_id,
  cd.prospect_name,
  cd.clean_name,
  cd.revenue,
  cd.cash_collected,
  cd.created_at,
  COALESCE(tm.ad_id,        gm.ad_id,        hyros_ad.ad_id)         AS resolved_ad_id,
  COALESCE(tm.adset_id,     gm.adset_id,     hyros_ad.adset_id)      AS resolved_adset_id,
  COALESCE(tm.utm_campaign, gm.utm_campaign, hm.campaign_name, hyros_ad.campaign_name) AS resolved_campaign,
  CASE
    WHEN tm.closer_call_id IS NOT NULL THEN 'typeform'
    WHEN gm.closer_call_id IS NOT NULL THEN 'ghl'
    WHEN hm.closer_call_id IS NOT NULL THEN 'hyros'
    ELSE 'orphan'
  END AS attribution_source
FROM closed cd
LEFT JOIN typeform_match tm ON tm.closer_call_id = cd.closer_call_id
LEFT JOIN ghl_match      gm ON gm.closer_call_id = cd.closer_call_id
LEFT JOIN hyros_match    hm ON hm.closer_call_id = cd.closer_call_id
LEFT JOIN LATERAL (
  SELECT a.ad_id, a.adset_id, a.campaign_name
  FROM public.ads a
  WHERE a.ad_id = hm.ad_id
  LIMIT 1
) hyros_ad ON true;

GRANT SELECT ON public.lib_close_resolved TO anon, authenticated;

-- Rebuild rollup + orphan views on top of the optimized resolver.
DROP VIEW IF EXISTS public.lib_close_per_ad CASCADE;
CREATE VIEW public.lib_close_per_ad AS
SELECT resolved_ad_id AS ad_id, count(*) AS closes,
  COALESCE(sum(revenue),0)        AS revenue,
  COALESCE(sum(cash_collected),0) AS cash,
  max(created_at)                 AS last_close_at
FROM public.lib_close_resolved WHERE resolved_ad_id IS NOT NULL GROUP BY resolved_ad_id;
GRANT SELECT ON public.lib_close_per_ad TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_close_per_adset CASCADE;
CREATE VIEW public.lib_close_per_adset AS
SELECT resolved_adset_id AS adset_id, count(*) AS closes,
  COALESCE(sum(revenue),0)        AS revenue,
  COALESCE(sum(cash_collected),0) AS cash,
  max(created_at)                 AS last_close_at
FROM public.lib_close_resolved WHERE resolved_adset_id IS NOT NULL GROUP BY resolved_adset_id;
GRANT SELECT ON public.lib_close_per_adset TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_close_per_campaign CASCADE;
CREATE VIEW public.lib_close_per_campaign AS
SELECT resolved_campaign AS utm_campaign, count(*) AS closes,
  COALESCE(sum(revenue),0)        AS revenue,
  COALESCE(sum(cash_collected),0) AS cash,
  max(created_at)                 AS last_close_at
FROM public.lib_close_resolved WHERE resolved_campaign IS NOT NULL GROUP BY resolved_campaign;
GRANT SELECT ON public.lib_close_per_campaign TO anon, authenticated;

DROP VIEW IF EXISTS public.lib_orphan_closes CASCADE;
CREATE VIEW public.lib_orphan_closes AS
SELECT closer_call_id, prospect_name, clean_name, revenue, cash_collected, created_at
FROM public.lib_close_resolved WHERE attribution_source = 'orphan'
ORDER BY created_at DESC;
GRANT SELECT ON public.lib_orphan_closes TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
