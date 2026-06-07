-- Migration 139: materialized copy of lib_marketing_by_audience_daily for the
-- historical trend panel.
--
-- Problem: MetricTrendPanel pulls the ENTIRE all-time view on every open
-- (no date filter, limit 20000). lib_marketing_by_audience_daily is a plain
-- VIEW that recomputes the whole close-resolver chain (lib_close_audience,
-- lib_closer_call_audience, lib_strategy_booking_resolved, marketing_tracker
-- backfill, 8 CTEs) per read. Over all-time this blows past Postgres'
-- statement_timeout → "canceling statement due to statement timeout" when
-- opening the Total Closes (and other) trend.
--
-- Fix: a MATERIALIZED VIEW that the trend reads instead. The heavy compute
-- runs on REFRESH (on sync / scheduled), not on every chart open.
--
-- IMPORTANT — why a SEPARATE object and not converting the view in place:
-- the live VIEW is still read by the KPI tiles + drilldown tile counts, which
-- must reflect spam/DQ exclusion marks immediately (the Bookings drilldown
-- marking feature depends on this). A matview would make those marks stale
-- until the next refresh. So tiles keep the live view; only the historical
-- trend (which tolerates refresh-latency) uses the matview.
--
-- Pre-req: 138_audience_aware_all_metrics.sql.

DROP MATERIALIZED VIEW IF EXISTS lib_marketing_by_audience_daily_mv;

CREATE MATERIALIZED VIEW lib_marketing_by_audience_daily_mv AS
  SELECT * FROM lib_marketing_by_audience_daily
WITH DATA;

-- Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY (and the
-- grain — one row per (date, audience) — is naturally unique).
CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_trend_mv_date_aud
  ON lib_marketing_by_audience_daily_mv (date, audience);

GRANT SELECT ON lib_marketing_by_audience_daily_mv TO authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- Refresh RPC — throttled (mirrors public.refresh_ad_library_views from 013).
-- Call after a sync, or on a cron. Throttled to 60s so rapid calls no-op.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public._marketing_trend_refresh_log (
  id           BIGSERIAL PRIMARY KEY,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public._marketing_trend_refresh_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "auth read mkt refresh log" ON public._marketing_trend_refresh_log
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT ON public._marketing_trend_refresh_log TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_marketing_trend_mv()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- CONCURRENTLY so readers aren't blocked; falls back to a plain refresh on
  -- the very first run (CONCURRENTLY requires the view to already be populated,
  -- which CREATE ... WITH DATA above guarantees, so this is safe).
  REFRESH MATERIALIZED VIEW CONCURRENTLY lib_marketing_by_audience_daily_mv;

  INSERT INTO public._marketing_trend_refresh_log DEFAULT VALUES;
  RETURN jsonb_build_object('refreshed', true, 'skipped', false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_marketing_trend_mv() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
