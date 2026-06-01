-- Audience-aware view over lib_close_resolved so the Marketing page's
-- Closes drilldown matches the tile (Ben 2026-06-01).
--
-- Before: fetchCloses pulled closer_calls + filtered by prospect-name match
-- against lib_strategy_booking_resolved. That missed every close whose
-- prospect never had a strategy booking (typeform-resolved closes like
-- George Sidhom). Tile said 4, drilldown said 2.
--
-- Now: fetchCloses queries this view with `.in('audience', [...])`. Audience
-- resolved via the same chain lib_marketing_by_audience_daily uses for the
-- tile count, so both numbers agree.
--
-- 'Referral' is its own bucket (matches the marketing view's exclusion
-- where resolved_campaign = 'REFERRAL') — keeps these out of the audience-
-- attributed totals but visible if Ben wants to inspect manual-attributed
-- closes specifically.

BEGIN;

CREATE OR REPLACE VIEW public.lib_close_audience AS
SELECT cr.*,
       CASE
         WHEN cr.resolved_campaign = 'REFERRAL' THEN 'Referral'
         ELSE COALESCE(
                aa.audience,
                public.audience_from_campaign_name(cr.resolved_campaign),
                'Unknown'
              )
       END AS audience
  FROM public.lib_close_resolved cr
  LEFT JOIN public.lib_ad_audience aa ON aa.ad_id = cr.resolved_ad_id;

GRANT SELECT ON public.lib_close_audience TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
