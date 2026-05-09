-- Throttle public.refresh_ad_library_views() so back-to-back invocations
-- skip if the last successful refresh ran less than 60 seconds ago.
--
-- Why: REFRESH MATERIALIZED VIEW CONCURRENTLY is non-blocking but still
-- expensive. With the RPC granted to the `authenticated` role, anyone with
-- a dashboard session can invoke it; rapid Sync clicks (or a future cron
-- mistake) would loop pointlessly. Returning JSON lets the caller see when
-- it was skipped vs ran.
--
-- Pre-req: 012_ad_variant_link.sql.

CREATE TABLE IF NOT EXISTS public._ad_library_refresh_log (
  id           BIGSERIAL PRIMARY KEY,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  initiated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_ad_library_refresh_log_time
  ON public._ad_library_refresh_log(refreshed_at DESC);

ALTER TABLE public._ad_library_refresh_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "auth read refresh log" ON public._ad_library_refresh_log
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT ON public._ad_library_refresh_log TO authenticated, service_role;
GRANT USAGE ON SEQUENCE public._ad_library_refresh_log_id_seq TO service_role;

-- Drop the old VOID-returning function (signature change to JSONB)
DROP FUNCTION IF EXISTS public.refresh_ad_library_views();

CREATE OR REPLACE FUNCTION public.refresh_ad_library_views()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, library
AS $$
DECLARE
  last_ts TIMESTAMPTZ;
  age_sec NUMERIC;
BEGIN
  SELECT refreshed_at INTO last_ts
  FROM public._ad_library_refresh_log
  ORDER BY refreshed_at DESC
  LIMIT 1;

  IF last_ts IS NOT NULL THEN
    age_sec := EXTRACT(EPOCH FROM (NOW() - last_ts));
    IF age_sec < 60 THEN
      RETURN jsonb_build_object(
        'refreshed', false,
        'skipped', true,
        'reason', 'throttled',
        'last_refresh_age_sec', age_sec
      );
    END IF;
  END IF;

  PERFORM library.refresh_materialized_views();
  INSERT INTO public._ad_library_refresh_log (initiated_by) VALUES (COALESCE(auth.role(), 'unknown'));

  RETURN jsonb_build_object(
    'refreshed', true,
    'skipped', false,
    'last_refresh_age_sec', age_sec
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_ad_library_views() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
