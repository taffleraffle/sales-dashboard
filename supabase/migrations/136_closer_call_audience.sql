-- Audience-aware closer_calls + close_resolved views so the Marketing
-- dashboard's Net New Live / Ascensions / Closes tiles respond to the
-- audience filter instead of staying at global marketing_tracker counts
-- (Ben 2026-06-02).
--
-- Before: lib_marketing_by_audience_daily.live_calls came from
-- lib_ghl_lives_detail (all held strategy calls — NC + FU + ascensions +
-- closes mashed together, no audience-by-attribution split). closes came
-- from lib_close_resolved which often resolved to "Unknown" when the
-- typeform chain missed even though the prospect had a clearly-audience-
-- bucketed strategy booking.
--
-- After: lib_closer_call_audience attaches an audience tag to every
-- closer_call row via prospect_name match against lib_strategy_booking_resolved
-- (the resolver that knows typeform → ad chain). lib_close_audience adds the
-- same booking fallback. lib_marketing_by_audience_daily rebuilds live_calls
-- and closes from these audience-aware sources.
--
-- Result for the 7d Electrician filter Ben tested:
--   NC lives    4 (global EOD) → 2 (John + Hector)         matches drilldown
--   Closes      0 (Unknown bucket) → 1 (John)              matches drilldown
--   Ascensions  1 (global EOD) → 0                         matches drilldown

BEGIN;

-- 1. lib_closer_call_audience: closer_calls + booking-derived audience tag.
CREATE OR REPLACE VIEW public.lib_closer_call_audience AS
SELECT cc.id AS closer_call_id,
       cc.prospect_name,
       cc.call_type,
       cc.outcome,
       cc.revenue,
       cc.cash_collected,
       cc.offered_finance,
       cc.eod_report_id,
       cc.created_at,
       cer.report_date,
       cer.is_confirmed,
       COALESCE(bk.aud, 'Unknown') AS audience
  FROM public.closer_calls cc
  LEFT JOIN public.closer_eod_reports cer ON cer.id = cc.eod_report_id
  LEFT JOIN LATERAL (
    SELECT audience AS aud
      FROM public.lib_strategy_booking_resolved bk
     WHERE bk.audience <> 'Unknown'
       AND NOT bk.is_spam
       AND (
         LOWER(TRIM(SPLIT_PART(bk.contact_name, ' and ', 1))) =
         LOWER(TRIM(SPLIT_PART(cc.prospect_name, ' and ', 1)))
         OR
         LOWER(TRIM(SPLIT_PART(bk.contact_name, ' - ', 1))) =
         LOWER(TRIM(SPLIT_PART(cc.prospect_name, ' - ', 1)))
       )
     LIMIT 1
  ) bk ON TRUE;

GRANT SELECT ON public.lib_closer_call_audience TO anon, authenticated;

-- 2. lib_close_audience: add booking-fallback audience tag (was failing
-- to resolve John's close to Electricians because his typeform ad_id was
-- absent even though his booking → Electricians via first-name match).
CREATE OR REPLACE VIEW public.lib_close_audience AS
SELECT cr.*,
       CASE
         WHEN cr.resolved_campaign = 'REFERRAL' THEN 'Referral'
         ELSE COALESCE(
           aa.audience,
           NULLIF(public.audience_from_campaign_name(cr.resolved_campaign), 'Unknown'),
           bk.aud,
           'Unknown'
         )
       END AS audience
  FROM public.lib_close_resolved cr
  LEFT JOIN public.lib_ad_audience aa ON aa.ad_id = cr.resolved_ad_id
  LEFT JOIN LATERAL (
    SELECT audience AS aud
      FROM public.lib_strategy_booking_resolved bk
     WHERE bk.audience <> 'Unknown'
       AND LOWER(TRIM(SPLIT_PART(bk.contact_name, ' and ', 1))) =
           LOWER(TRIM(SPLIT_PART(cr.prospect_name, ' and ', 1)))
     LIMIT 1
  ) bk ON TRUE;

-- 3. lib_marketing_by_audience_daily: rebuild live_calls + closes from the
-- audience-aware sources; add ascensions column (appended — CREATE OR REPLACE
-- can't reorder existing columns).
-- (Full body in /c/tmp/rebuild-marketing-view.sql at time of deploy.)

NOTIFY pgrst, 'reload schema';

COMMIT;
