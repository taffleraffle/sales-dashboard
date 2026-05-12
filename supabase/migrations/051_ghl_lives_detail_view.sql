-- 051_ghl_lives_detail_view.sql
-- Adds lib_ghl_lives_detail — a per-call detail view for live calls
-- attributed to a Meta ad. Mirror of lib_ghl_booked_detail but built
-- from closer_calls (showed=true) -> ghl_contacts via name-token match
-- (the same resolver used in lib_ghl_lives_per_*).
--
-- Why: AdsPerformance.jsx needs to date-filter live calls so a campaign
-- that hasn't run in 90 days doesn't show 80 historical live calls
-- against $0 of in-range spend. Without a detail view exposing the
-- call's created_at, client-side filtering is impossible.
--
-- Idempotent. Apply via supabase db push.

BEGIN;

DROP VIEW IF EXISTS public.lib_ghl_lives_detail CASCADE;
CREATE VIEW public.lib_ghl_lives_detail AS
WITH live AS (
  SELECT
    cc.id                                                            AS closer_call_id,
    cc.prospect_name                                                 AS display_name,
    cc.created_at                                                    AS landed_at,
    cc.outcome,
    cc.cash_collected,
    cc.revenue,
    public.name_first_token (public.strip_call_suffix(cc.prospect_name)) AS first_tok,
    public.name_second_token(public.strip_call_suffix(cc.prospect_name)) AS second_tok
  FROM public.closer_calls cc
  WHERE cc.showed = TRUE OR cc.outcome IN ('showed','closed','not_closed')
),
matched AS (
  SELECT DISTINCT ON (li.closer_call_id)
    li.closer_call_id,
    li.display_name,
    li.landed_at,
    li.outcome,
    li.cash_collected,
    li.revenue,
    COALESCE(g.last_ad_id, g.first_ad_id) AS ad_id
  FROM live li
  JOIN public.ghl_contacts g
    ON public.name_first_token(g.first_name) = li.first_tok
   AND (li.second_tok = ''
        OR lower(coalesce(g.last_name, g.full_name, '')) ILIKE '%' || li.second_tok || '%')
  WHERE COALESCE(g.last_ad_id, g.first_ad_id) IS NOT NULL
  ORDER BY li.closer_call_id, g.date_added DESC NULLS LAST
)
SELECT
  m.closer_call_id,
  m.display_name,
  m.landed_at,
  m.outcome,
  m.cash_collected,
  m.revenue,
  m.ad_id,
  a.adset_id,
  a.campaign_name AS utm_campaign
FROM matched m
LEFT JOIN public.ads a ON a.ad_id = m.ad_id
WHERE m.ad_id IS NOT NULL;

GRANT SELECT ON public.lib_ghl_lives_detail TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
