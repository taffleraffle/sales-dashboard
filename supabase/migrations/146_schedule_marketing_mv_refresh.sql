-- 146: actually schedule the marketing MV refresh.
--
-- The tiles + trend panel read lib_marketing_by_audience_daily_mv, but
-- NOTHING refreshed it on a schedule — refresh_marketing_trend_mv() existed
-- (throttled, CONCURRENTLY, logged) yet no cron job called it. Meanwhile
-- the attribution syncs (typeform hourly, GHL/Stripe 2-hourly, Hyros
-- 6-hourly) keep re-resolving closes/calls underneath, so the LIVE views
-- (drilldowns) drift away from the STALE snapshot (tiles) until someone
-- happens to refresh it. Observed 2026-06-10: MV said Electricians 2 /
-- Restoration 1 net-live while the live view said the opposite — same
-- window, same metric, two answers on one screen.
--
-- Every 10 minutes is cheap (the function self-throttles to 60s minimum
-- and refreshes CONCURRENTLY so readers never block).

select cron.schedule(
  'refresh-marketing-trend-mv',
  '*/10 * * * *',
  $$select public.refresh_marketing_trend_mv()$$
);

-- Bring the snapshot current immediately.
select public.refresh_marketing_trend_mv();
