-- 034_attribution_health.sql
-- Surface the HYROS attribution gap. The performance dashboard rolls up per
-- ad_id and silently hides events that arrive without an ad_id. Ben sees
-- fewer leads on the dashboard than in HYROS itself and (rightly) thinks
-- something is broken. This view tells the truth.

BEGIN;

CREATE OR REPLACE VIEW public.lib_hyros_attribution_health AS
SELECT
  COUNT(*)                                                       AS total_events,
  COUNT(*) FILTER (WHERE meta_ad_id IS NOT NULL)                 AS attributed_to_ad,
  COUNT(*) FILTER (WHERE meta_ad_id IS NULL
                   AND campaign_name IS NOT NULL)                AS campaign_only,
  COUNT(*) FILTER (WHERE meta_ad_id IS NULL
                   AND campaign_name IS NULL
                   AND source IS NOT NULL)                       AS source_only,
  COUNT(*) FILTER (WHERE meta_ad_id IS NULL
                   AND campaign_name IS NULL
                   AND source IS NULL)                           AS fully_unattributed,
  COUNT(*) FILTER (WHERE event_type = 'call.attributed')         AS calls_total,
  COUNT(*) FILTER (WHERE event_type = 'call.attributed'
                   AND meta_ad_id IS NOT NULL)                   AS calls_with_ad,
  COUNT(*) FILTER (WHERE event_type = 'lead.attributed')         AS leads_total,
  COUNT(*) FILTER (WHERE event_type = 'lead.attributed'
                   AND meta_ad_id IS NOT NULL)                   AS leads_with_ad,
  MAX(event_date)                                                AS latest_event
FROM public.hyros_events
WHERE event_date >= CURRENT_DATE - 30;

GRANT SELECT ON public.lib_hyros_attribution_health TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
