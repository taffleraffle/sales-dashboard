-- Performance indexes to fix the Ads Performance page timing out 3 of its
-- 7 parallel queries (Ben 2026-06-01: "loading forever / can't even use it").
--
-- Root cause: lib_ghl_leads_detail wraps ghl_contacts with NO index on
-- date_added, so the view's seq-scan + per-row resolve_ad_id_from_typeform()
-- function call ran the entire ghl_contacts table on every page load.
-- Same shape for lib_close_resolved (closer_calls eod_report_id join) and
-- lib_ghl_lives_detail. After these indexes all three queries return in
-- 2-3 seconds instead of hitting the 60-second statement_timeout.
--
-- Already applied directly to prod via the Mgmt API. Committed here so a
-- fresh DB rebuild gets them automatically.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_ghl_contacts_date_added
  ON public.ghl_contacts (date_added);

CREATE INDEX IF NOT EXISTS idx_closer_calls_eod_report_id
  ON public.closer_calls (eod_report_id);

CREATE INDEX IF NOT EXISTS idx_closer_calls_outcome_calltype
  ON public.closer_calls (outcome, call_type);

CREATE INDEX IF NOT EXISTS idx_ad_daily_stats_date_ad
  ON public.ad_daily_stats (date, ad_id);

CREATE INDEX IF NOT EXISTS idx_tfr_email_lower
  ON public.typeform_responses (LOWER(email))
  WHERE email IS NOT NULL;

ANALYZE public.ghl_contacts;
ANALYZE public.closer_calls;
ANALYZE public.ad_daily_stats;

COMMIT;
