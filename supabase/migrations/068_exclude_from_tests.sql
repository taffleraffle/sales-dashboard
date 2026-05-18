-- 068_exclude_from_tests.sql
--
-- Operator wants to mark specific ads as "not part of testing right now"
-- so they're excluded from win-rate, variables-pulling-ahead, and other
-- attribute analyses. Use case: keep evergreen creatives running without
-- having them pollute the testing baseline.
--
-- Implementation: one boolean on creative_attributes. NULL/FALSE = in
-- scope. TRUE = excluded from the testing analysis. The lib_ad_performance
-- function exposes this so the frontend can filter at the row level
-- without an extra round-trip.

BEGIN;

ALTER TABLE public.creative_attributes
  ADD COLUMN IF NOT EXISTS exclude_from_tests BOOLEAN NOT NULL DEFAULT FALSE;

DROP FUNCTION IF EXISTS public.lib_ad_performance(DATE, DATE) CASCADE;

CREATE OR REPLACE FUNCTION public.lib_ad_performance(since DATE, until DATE)
RETURNS TABLE (
  ad_id                    TEXT,
  ad_name                  TEXT,
  campaign_name            TEXT,
  adset_name               TEXT,
  offer_slug               TEXT,
  vertical                 TEXT,

  thumbnail_url            TEXT,
  asset_url                TEXT,
  asset_type               TEXT,

  status                   TEXT,
  effective_status         TEXT,
  is_live                  BOOLEAN,

  spend                    NUMERIC,
  impressions              BIGINT,
  clicks                   BIGINT,
  leads                    BIGINT,
  booked                   BIGINT,
  closes                   BIGINT,
  revenue                  NUMERIC,
  cash                     NUMERIC,

  cost_per_lead            NUMERIC,
  cost_per_booked          NUMERIC,
  cost_per_close           NUMERIC,
  close_rate               NUMERIC,

  hook_type                TEXT,
  message_frame            TEXT,
  mechanism_reveal         TEXT,
  proof_character          TEXT,
  pain_angle               TEXT,
  funnel_stage             TEXT,
  awareness_level          TEXT,
  length_bucket            TEXT,
  format                   TEXT,
  actor                    TEXT,

  manual_winner_override   BOOLEAN,
  winner_auto_detected     BOOLEAN,
  effective_winner         BOOLEAN,

  extracted_at             TIMESTAMPTZ,
  attributes_complete      BOOLEAN,

  linked_script_id         UUID,
  transcript_source        TEXT,
  assignment_status        TEXT,

  -- NEW (068)
  exclude_from_tests       BOOLEAN
)
LANGUAGE SQL STABLE AS $$
  WITH spend_window AS (
    SELECT ad_id, SUM(spend) AS spend, SUM(impressions) AS impressions, SUM(clicks) AS clicks
    FROM public.ad_daily_stats WHERE date BETWEEN since AND until GROUP BY ad_id
  ),
  leads_window AS (
    SELECT COALESCE(last_ad_id, first_ad_id) AS ad_id, COUNT(*) AS leads
    FROM public.ghl_contacts
    WHERE COALESCE(last_ad_id, first_ad_id) IS NOT NULL
      AND date_added::date BETWEEN since AND until
    GROUP BY COALESCE(last_ad_id, first_ad_id)
  ),
  booked_window AS (
    SELECT ad_id, COUNT(*) FILTER (WHERE landed_at::date BETWEEN since AND until) AS booked
    FROM public.lib_ghl_booked_detail WHERE ad_id IS NOT NULL GROUP BY ad_id
  ),
  closes_window AS (
    SELECT resolved_ad_id AS ad_id,
      COUNT(*)                          FILTER (WHERE created_at::date BETWEEN since AND until) AS closes,
      COALESCE(SUM(revenue)        FILTER (WHERE created_at::date BETWEEN since AND until), 0)  AS revenue,
      COALESCE(SUM(cash_collected) FILTER (WHERE created_at::date BETWEEN since AND until), 0)  AS cash
    FROM public.lib_close_resolved WHERE resolved_ad_id IS NOT NULL GROUP BY resolved_ad_id
  ),
  scripts AS (
    SELECT DISTINCT ON (ad_id) ad_id, id AS linked_script_id
    FROM public.generated_scripts WHERE ad_id IS NOT NULL
    ORDER BY ad_id, updated_at DESC
  ),
  transcripts AS (
    SELECT DISTINCT ON (ad_id) ad_id, source AS transcript_source
    FROM public.lib_creative_transcripts WHERE ad_id IS NOT NULL
    ORDER BY ad_id, CASE source
      WHEN 'manual' THEN 1 WHEN 'whisper_api' THEN 2 WHEN 'whisper_local' THEN 3
      WHEN 'meta_caption' THEN 4 WHEN 'ad_copy' THEN 5 ELSE 99 END
  )
  SELECT
    a.ad_id, a.ad_name, a.campaign_name, a.adset_name,
    ca.offer_slug, ca.vertical,
    a.thumbnail_url, a.asset_url, a.asset_type,
    a.status, a.effective_status, (a.effective_status = 'ACTIVE') AS is_live,
    COALESCE(s.spend, 0), COALESCE(s.impressions, 0), COALESCE(s.clicks, 0),
    COALESCE(l.leads, 0), COALESCE(b.booked, 0),
    COALESCE(c.closes, 0), COALESCE(c.revenue, 0), COALESCE(c.cash, 0),
    CASE WHEN COALESCE(l.leads, 0)  > 0 THEN s.spend / l.leads  END,
    CASE WHEN COALESCE(b.booked, 0) > 0 THEN s.spend / b.booked END,
    CASE WHEN COALESCE(c.closes, 0) > 0 THEN s.spend / c.closes END,
    CASE WHEN COALESCE(b.booked, 0) > 0 THEN c.closes::numeric / b.booked END,
    ca.hook_type, ca.message_frame, ca.mechanism_reveal, ca.proof_character,
    ca.pain_angle, ca.funnel_stage, ca.awareness_level, ca.length_bucket,
    ca.format, ca.actor,
    ca.manual_winner_override,
    COALESCE(s.spend >= 1000 AND b.booked >= 2 AND (s.spend / NULLIF(b.booked, 0)) <= 300, FALSE),
    COALESCE(ca.manual_winner_override,
      s.spend >= 1000 AND b.booked >= 2 AND (s.spend / NULLIF(b.booked, 0)) <= 300, FALSE),
    ca.extracted_at,
    (ca.hook_type IS NOT NULL AND ca.message_frame IS NOT NULL AND ca.mechanism_reveal IS NOT NULL
       AND ca.proof_character IS NOT NULL AND ca.pain_angle IS NOT NULL AND ca.funnel_stage IS NOT NULL
       AND ca.awareness_level IS NOT NULL AND ca.length_bucket IS NOT NULL AND ca.format IS NOT NULL),
    sc.linked_script_id, tr.transcript_source,
    CASE
      WHEN sc.linked_script_id IS NOT NULL THEN 'assigned'
      WHEN tr.transcript_source = 'manual' THEN 'manual_transcript'
      WHEN tr.transcript_source IN ('whisper_api', 'whisper_local') THEN 'auto_transcript'
      WHEN tr.transcript_source = 'meta_caption' THEN 'auto_transcript'
      WHEN tr.transcript_source = 'ad_copy' THEN 'ad_copy_only'
      ELSE 'unassigned'
    END,
    COALESCE(ca.exclude_from_tests, FALSE)
  FROM public.ads a
  LEFT JOIN spend_window  s  ON s.ad_id  = a.ad_id
  LEFT JOIN leads_window  l  ON l.ad_id  = a.ad_id
  LEFT JOIN booked_window b  ON b.ad_id  = a.ad_id
  LEFT JOIN closes_window c  ON c.ad_id  = a.ad_id
  LEFT JOIN public.creative_attributes ca ON ca.ad_id = a.ad_id
  LEFT JOIN scripts       sc ON sc.ad_id = a.ad_id
  LEFT JOIN transcripts   tr ON tr.ad_id = a.ad_id;
$$;

GRANT EXECUTE ON FUNCTION public.lib_ad_performance(DATE, DATE) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
