-- 030_hyros_ad_attribution.sql
-- Adds ad-level attribution columns to hyros_events.
--
-- Why: HYROS's webhook payload puts the Meta ad_id at
--   body.firstSource.adSource.adSourceId  (= the Meta ad that created the source link)
--   body.lastSource.sourceLinkAd.adSourceId  (= the Meta ad the lead actually clicked)
-- The existing webhook only grabbed campaign_name from a non-existent attribution[]
-- array, so all 175 events have null ad_id. These columns + a webhook patch (separate)
-- give us a proper ad-level join key into public.ads.
--
-- Idempotent. Apply via Supabase Studio SQL editor.

BEGIN;

ALTER TABLE public.hyros_events
  ADD COLUMN IF NOT EXISTS meta_ad_id          TEXT,
  ADD COLUMN IF NOT EXISTS source_link_ad_id   TEXT,
  ADD COLUMN IF NOT EXISTS source_link_ad_name TEXT,
  ADD COLUMN IF NOT EXISTS lead_tags           TEXT[],
  ADD COLUMN IF NOT EXISTS click_id            TEXT,
  ADD COLUMN IF NOT EXISTS call_state          TEXT;

CREATE INDEX IF NOT EXISTS idx_hyros_events_meta_ad_id
  ON public.hyros_events(meta_ad_id) WHERE meta_ad_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hyros_events_source_link_ad_id
  ON public.hyros_events(source_link_ad_id) WHERE source_link_ad_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hyros_events_event_date
  ON public.hyros_events(event_date DESC);

-- Unique constraint so hyros-sync can ON CONFLICT (hyros_event_id).
ALTER TABLE public.hyros_events
  DROP CONSTRAINT IF EXISTS hyros_events_event_id_key;
ALTER TABLE public.hyros_events
  ADD CONSTRAINT hyros_events_event_id_key UNIQUE (hyros_event_id);

-- Convenience view: HYROS-attributed calls/leads/sales rolled up per Meta ad,
-- last 90 days. Joins to public.ads so the gallery can show real attributed
-- close/revenue numbers instead of the current hardcoded zeros.
-- Uses is_qualified (set by both webhook + API paths) rather than call_state
-- (which is API-only) so the qualified count includes legacy webhook events.
DROP VIEW IF EXISTS public.lib_hyros_ad_attribution;
CREATE VIEW public.lib_hyros_ad_attribution AS
SELECT
  COALESCE(h.source_link_ad_id, h.meta_ad_id) AS ad_id,
  count(*) FILTER (WHERE h.event_type = 'call.attributed')                            AS calls_attributed,
  count(*) FILTER (WHERE h.event_type = 'call.attributed' AND h.is_qualified IS TRUE) AS calls_qualified,
  count(*) FILTER (WHERE h.event_type = 'lead.attributed')                            AS leads_attributed,
  count(*) FILTER (WHERE h.event_type = 'sale.attributed')                            AS sales_attributed,
  sum(h.revenue) FILTER (WHERE h.event_type = 'sale.attributed')                      AS revenue_attributed,
  max(h.event_date)                                                                   AS last_event_date
FROM public.hyros_events h
WHERE COALESCE(h.source_link_ad_id, h.meta_ad_id) IS NOT NULL
  AND h.event_date >= CURRENT_DATE - 90
GROUP BY 1;

GRANT SELECT ON public.lib_hyros_ad_attribution TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
