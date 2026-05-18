-- 065_lib_ad_performance_assignment_status.sql
--
-- Adds assignment-status columns to lib_ad_performance so the Creatives
-- Library can show explicit Assigned / Transcript / Unassigned chips per row.
--
-- New columns appended to RETURNS TABLE:
--   linked_script_id  UUID  - generated_scripts.id this ad is linked to (NULL if none)
--   transcript_source TEXT  - best transcript source: 'manual' > 'whisper_api' > 'whisper_local' > 'meta_caption' > 'ad_copy' > NULL
--   assignment_status TEXT  - 'assigned' (linked to a script) | 'manual_transcript' (operator added one) | 'auto_transcript' (whisper / meta only) | 'ad_copy_only' (just headline+body) | 'unassigned' (nothing)
--
-- Apply via supabase db push.

BEGIN;

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

  -- NEW (065): assignment / transcript status
  linked_script_id         UUID,
  transcript_source        TEXT,
  assignment_status        TEXT
)
LANGUAGE SQL STABLE AS $$
  WITH spend_window AS (
    SELECT
      ad_id,
      SUM(spend)        AS spend,
      SUM(impressions)  AS impressions,
      SUM(clicks)       AS clicks
    FROM public.ad_daily_stats
    WHERE date BETWEEN since AND until
    GROUP BY ad_id
  ),
  leads_window AS (
    SELECT
      COALESCE(last_ad_id, first_ad_id) AS ad_id,
      COUNT(*) AS leads
    FROM public.ghl_contacts
    WHERE COALESCE(last_ad_id, first_ad_id) IS NOT NULL
      AND date_added::date BETWEEN since AND until
    GROUP BY COALESCE(last_ad_id, first_ad_id)
  ),
  booked_window AS (
    SELECT
      ad_id,
      COUNT(*) FILTER (WHERE landed_at::date BETWEEN since AND until) AS booked
    FROM public.lib_ghl_booked_detail
    WHERE ad_id IS NOT NULL
    GROUP BY ad_id
  ),
  closes_window AS (
    SELECT
      resolved_ad_id AS ad_id,
      COUNT(*)                          FILTER (WHERE created_at::date BETWEEN since AND until) AS closes,
      COALESCE(SUM(revenue)        FILTER (WHERE created_at::date BETWEEN since AND until), 0)  AS revenue,
      COALESCE(SUM(cash_collected) FILTER (WHERE created_at::date BETWEEN since AND until), 0)  AS cash
    FROM public.lib_close_resolved
    WHERE resolved_ad_id IS NOT NULL
    GROUP BY resolved_ad_id
  ),
  -- NEW: latest linked script per ad (most recent generated_scripts row)
  scripts AS (
    SELECT DISTINCT ON (ad_id) ad_id, id AS linked_script_id
    FROM public.generated_scripts
    WHERE ad_id IS NOT NULL
    ORDER BY ad_id, updated_at DESC
  ),
  -- NEW: best transcript per ad (priority: manual > whisper > meta_caption > ad_copy)
  transcripts AS (
    SELECT DISTINCT ON (ad_id) ad_id, source AS transcript_source
    FROM public.lib_creative_transcripts
    WHERE ad_id IS NOT NULL
    ORDER BY ad_id, CASE source
      WHEN 'manual'         THEN 1
      WHEN 'whisper_api'    THEN 2
      WHEN 'whisper_local'  THEN 3
      WHEN 'meta_caption'   THEN 4
      WHEN 'ad_copy'        THEN 5
      ELSE 99
    END
  )
  SELECT
    a.ad_id,
    a.ad_name,
    a.campaign_name,
    a.adset_name,
    ca.offer_slug,
    ca.vertical,

    a.thumbnail_url,
    a.asset_url,
    a.asset_type,

    COALESCE(s.spend, 0)              AS spend,
    COALESCE(s.impressions, 0)        AS impressions,
    COALESCE(s.clicks, 0)             AS clicks,
    COALESCE(l.leads, 0)              AS leads,
    COALESCE(b.booked, 0)             AS booked,
    COALESCE(c.closes, 0)             AS closes,
    COALESCE(c.revenue, 0)            AS revenue,
    COALESCE(c.cash, 0)               AS cash,

    CASE WHEN COALESCE(l.leads, 0)  > 0 THEN s.spend / l.leads  END AS cost_per_lead,
    CASE WHEN COALESCE(b.booked, 0) > 0 THEN s.spend / b.booked END AS cost_per_booked,
    CASE WHEN COALESCE(c.closes, 0) > 0 THEN s.spend / c.closes END AS cost_per_close,
    CASE WHEN COALESCE(b.booked, 0) > 0 THEN c.closes::numeric / b.booked END AS close_rate,

    ca.hook_type,
    ca.message_frame,
    ca.mechanism_reveal,
    ca.proof_character,
    ca.pain_angle,
    ca.funnel_stage,
    ca.awareness_level,
    ca.length_bucket,
    ca.format,
    ca.actor,

    ca.manual_winner_override,
    COALESCE(
      s.spend >= 1000
        AND b.booked >= 2
        AND (s.spend / NULLIF(b.booked, 0)) <= 300,
      FALSE
    ) AS winner_auto_detected,
    COALESCE(
      ca.manual_winner_override,
      s.spend >= 1000
        AND b.booked >= 2
        AND (s.spend / NULLIF(b.booked, 0)) <= 300,
      FALSE
    ) AS effective_winner,

    ca.extracted_at,
    (ca.hook_type IS NOT NULL
       AND ca.message_frame IS NOT NULL
       AND ca.mechanism_reveal IS NOT NULL
       AND ca.proof_character IS NOT NULL
       AND ca.pain_angle IS NOT NULL
       AND ca.funnel_stage IS NOT NULL
       AND ca.awareness_level IS NOT NULL
       AND ca.length_bucket IS NOT NULL
       AND ca.format IS NOT NULL
    ) AS attributes_complete,

    sc.linked_script_id,
    tr.transcript_source,
    CASE
      WHEN sc.linked_script_id IS NOT NULL THEN 'assigned'
      WHEN tr.transcript_source = 'manual' THEN 'manual_transcript'
      WHEN tr.transcript_source IN ('whisper_api', 'whisper_local') THEN 'auto_transcript'
      WHEN tr.transcript_source = 'meta_caption' THEN 'auto_transcript'
      WHEN tr.transcript_source = 'ad_copy' THEN 'ad_copy_only'
      ELSE 'unassigned'
    END AS assignment_status

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
