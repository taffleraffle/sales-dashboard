-- 151: materialize the heavy resolvers — drilldowns drop from ~4s to ~ms.
--
-- Measured in production: lib_close_audience 4.5s, lib_closer_call_audience
-- 3.8s, lib_strategy_booking_resolved 2.7s per query. Every drilldown open
-- re-ran the full close-resolver (fuzzy name matching across typeform, GHL,
-- and Hyros) live. Snapshot both resolvers as matviews and point the
-- audience views at the snapshots. refresh_marketing_trend_mv() now
-- refreshes all three in dependency order on the existing 10-min cron, and
-- the funnel-editor UI already calls it after every override edit, so
-- manual corrections still show up within seconds.
--
-- Staleness contract: resolution-derived data is at most ~10 min old —
-- identical to the tiles, which read lib_marketing_by_audience_daily_mv.

-- 1. Booking resolver snapshot. id is unique (the view dedupes per contact),
--    required for REFRESH ... CONCURRENTLY.
create materialized view if not exists public.lib_booking_resolved_mv as
  select * from public.lib_strategy_booking_resolved;
create unique index if not exists idx_booking_resolved_mv_id
  on public.lib_booking_resolved_mv (id);

-- 2. Close resolver snapshot. One row per closed call.
create materialized view if not exists public.lib_close_resolved_mv as
  select * from public.lib_close_resolved;
create unique index if not exists idx_close_resolved_mv_id
  on public.lib_close_resolved_mv (closer_call_id);

-- 3. Audience views read the snapshots (definitions otherwise identical to
--    migration 149).
create or replace view public.lib_close_audience as
SELECT cr.closer_call_id,
    cr.prospect_name,
    cr.clean_name,
    cr.revenue,
    cr.cash_collected,
    cr.created_at,
    cr.resolved_ad_id,
    cr.resolved_adset_id,
    cr.resolved_campaign,
    cr.attribution_source,
        CASE
            WHEN ov.audience IS NOT NULL THEN ov.audience
            WHEN cr.resolved_campaign = 'REFERRAL'::text THEN 'Referral'::text
            ELSE COALESCE(aa.audience, NULLIF(audience_from_campaign_name(cr.resolved_campaign), 'Unknown'::text), bk.aud, 'Unknown'::text)
        END AS audience
   FROM lib_close_resolved_mv cr
     LEFT JOIN close_attribution_overrides ov ON ov.closer_call_id = cr.closer_call_id
     LEFT JOIN lib_ad_audience aa ON aa.ad_id = cr.resolved_ad_id
     LEFT JOIN LATERAL ( SELECT bk_1.audience AS aud
           FROM lib_booking_resolved_mv bk_1
          WHERE bk_1.audience <> 'Unknown'::text AND NOT bk_1.is_spam
            AND (lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' and '::text, 1))) = lower(TRIM(BOTH FROM split_part(cr.prospect_name::text, ' and '::text, 1)))
              OR lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' - '::text, 1))) = lower(TRIM(BOTH FROM split_part(cr.prospect_name::text, ' - '::text, 1))))
          ORDER BY bk_1.booked_at DESC NULLS LAST, bk_1.id
         LIMIT 1) bk ON true;

create or replace view public.lib_closer_call_audience as
SELECT cc.id AS closer_call_id,
    cc.prospect_name,
    TRIM(BOTH FROM split_part(cc.prospect_name::text, ' and '::text, 1)) AS clean_first_part,
    TRIM(BOTH FROM split_part(cc.prospect_name::text, ' - '::text, 1)) AS strip_suffix,
    cc.call_type,
    cc.outcome,
    cc.revenue,
    cc.cash_collected,
    cc.offered_finance,
    cc.eod_report_id,
    cc.created_at,
    cer.report_date,
    cer.is_confirmed,
    COALESCE(cl.aud, bk.aud, 'Unknown'::text) AS audience
   FROM closer_calls cc
     LEFT JOIN closer_eod_reports cer ON cer.id = cc.eod_report_id
     LEFT JOIN LATERAL ( SELECT ca.audience AS aud
           FROM lib_close_audience ca
          WHERE ca.closer_call_id = cc.id AND ca.audience <> 'Unknown'::text
         LIMIT 1) cl ON true
     LEFT JOIN LATERAL ( SELECT bk_1.audience AS aud
           FROM lib_booking_resolved_mv bk_1
          WHERE bk_1.audience <> 'Unknown'::text AND NOT bk_1.is_spam
            AND (lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' and '::text, 1))) = lower(TRIM(BOTH FROM split_part(cc.prospect_name::text, ' and '::text, 1)))
              OR lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' - '::text, 1))) = lower(TRIM(BOTH FROM split_part(cc.prospect_name::text, ' - '::text, 1))))
          ORDER BY bk_1.booked_at DESC NULLS LAST, bk_1.id
         LIMIT 1) bk ON true;

-- 4. The refresh function now rebuilds all three snapshots in dependency
--    order (bookings → closes → trend rollup). Same name/signature, same
--    60s throttle, CONCURRENTLY throughout so readers never block.
create or replace function public.refresh_marketing_trend_mv()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  last_ts TIMESTAMPTZ;
  age_sec NUMERIC;
BEGIN
  SELECT refreshed_at INTO last_ts
  FROM public._marketing_trend_refresh_log
  ORDER BY refreshed_at DESC LIMIT 1;

  IF last_ts IS NOT NULL THEN
    age_sec := EXTRACT(EPOCH FROM (NOW() - last_ts));
    IF age_sec < 60 THEN
      RETURN jsonb_build_object('refreshed', false, 'skipped', true,
        'reason', 'throttled', 'last_refresh_age_sec', age_sec);
    END IF;
  END IF;

  -- Dependency order: the close snapshot's audience views read the booking
  -- snapshot, and the trend rollup reads both via the audience views.
  REFRESH MATERIALIZED VIEW CONCURRENTLY lib_booking_resolved_mv;
  REFRESH MATERIALIZED VIEW CONCURRENTLY lib_close_resolved_mv;
  REFRESH MATERIALIZED VIEW CONCURRENTLY lib_marketing_by_audience_daily_mv;

  INSERT INTO public._marketing_trend_refresh_log DEFAULT VALUES;
  RETURN jsonb_build_object('refreshed', true, 'skipped', false);
END;
$function$;

-- Snapshot everything now.
select public.refresh_marketing_trend_mv();
