-- Attribution QA queue (Ben 2026-06-01).
--
-- Ben's request: "if you're unsure about certain live calls or closes,
-- just flag them, and then I can just QA them myself and tell you what
-- they are for."
--
-- Add a match_confidence column to lib_ghl_lives_detail + lib_close_
-- resolved so the page can show high-confidence rows in the normal
-- breakdown and surface low-confidence rows in a QA queue.
--
-- Confidence ladder (highest to lowest):
--   manual   - close_attribution_overrides row exists (Ben told us)
--   strong   - typeform first + last name match, OR exact ad_id match
--   medium   - audience-hint match (calendar suffix + form_name align)
--              OR strong GHL contact match via email/phone
--   weak     - first name only + single typeform candidate
--              OR funnel-consensus (multiple candidates, same form_name)
--   orphan   - no resolver path produced an answer
--
-- Anything weak or orphan goes in the QA queue.

BEGIN;

-- ---------------------------------------------------------------------------
-- lib_ghl_lives_detail: add match_confidence column
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.lib_ghl_lives_detail AS
WITH live AS (
  SELECT cc.id AS closer_call_id,
         cc.prospect_name AS display_name,
         cc.created_at    AS landed_at,
         cc.outcome,
         cc.cash_collected,
         cc.revenue,
         name_first_token(strip_call_suffix(cc.prospect_name::text))  AS first_tok,
         name_second_token(strip_call_suffix(cc.prospect_name::text)) AS second_tok,
         audience_from_prospect_name(cc.prospect_name::text)          AS audience_hint
    FROM closer_calls cc
   WHERE cc.showed = true
      OR (cc.outcome::text = ANY (ARRAY['showed','closed','not_closed']::text[]))
),
manual_match AS (
  SELECT li.closer_call_id, li.display_name, li.landed_at, li.outcome,
         li.cash_collected, li.revenue,
         ov.ad_id, ov.adset_id, ov.utm_campaign,
         'manual'::text AS match_confidence
    FROM live li
    JOIN close_attribution_overrides ov ON ov.closer_call_id = li.closer_call_id
   WHERE ov.ad_id IS NOT NULL OR ov.utm_campaign IS NOT NULL
),
tf_candidates AS (
  SELECT
    li.closer_call_id, li.display_name, li.landed_at, li.outcome,
    li.cash_collected, li.revenue, li.audience_hint,
    t.ad_id AS tf_ad_id, t.utm_campaign AS tf_utm_campaign, t.utm_term AS tf_adset_id,
    t.submitted_at, t.form_name,
    CASE
      WHEN li.second_tok <> ''
       AND lower(COALESCE(t.last_name, '')) ILIKE ('%' || li.second_tok || '%')
        THEN 1
      WHEN form_name_matches_audience(t.form_name, li.audience_hint)
        THEN 2
      WHEN li.second_tok = ''
        THEN 3
      ELSE 4
    END AS score
    FROM live li
    JOIN typeform_responses t
      ON lower(split_part(t.first_name, ' ', 1)) = li.first_tok
     AND t.submitted_at::date <= li.landed_at::date
     AND t.submitted_at::date >= (li.landed_at::date - INTERVAL '60 days')
   WHERE t.ad_id IS NOT NULL OR t.utm_campaign IS NOT NULL OR t.utm_term IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM manual_match m WHERE m.closer_call_id = li.closer_call_id)
),
tf_weak_stats AS (
  SELECT closer_call_id, COUNT(*) AS weak_count,
         COUNT(DISTINCT form_name) AS weak_form_count
    FROM tf_candidates WHERE score = 3 GROUP BY closer_call_id
),
tf_ranked AS (
  SELECT c.*,
         COALESCE(s.weak_count, 0) AS weak_count,
         COALESCE(s.weak_form_count, 0) AS weak_form_count,
         ROW_NUMBER() OVER (PARTITION BY c.closer_call_id ORDER BY c.score, c.submitted_at DESC) AS rn
    FROM tf_candidates c
    LEFT JOIN tf_weak_stats s ON s.closer_call_id = c.closer_call_id
),
tf_matched AS (
  SELECT closer_call_id, display_name, landed_at, outcome,
         cash_collected, revenue,
         tf_ad_id, tf_utm_campaign, tf_adset_id,
         -- map score to confidence
         CASE
           WHEN score = 1 THEN 'strong'
           WHEN score = 2 THEN 'medium'
           WHEN score = 3 AND weak_count = 1 THEN 'weak'
           WHEN score = 3 AND weak_count > 1 AND weak_form_count = 1 THEN 'weak'
           ELSE 'weak'
         END AS match_confidence
    FROM tf_ranked
   WHERE rn = 1
     AND (score IN (1, 2)
          OR (score = 3 AND weak_count = 1)
          OR (score = 3 AND weak_count > 1 AND weak_form_count = 1))
),
ghl_candidates AS (
  SELECT
    li.closer_call_id, li.display_name, li.landed_at, li.outcome,
    li.cash_collected, li.revenue, li.audience_hint,
    g.ghl_contact_id, g.email, g.phone, g.last_name, g.source,
    g.last_ad_id, g.first_ad_id, g.date_added,
    CASE
      WHEN li.second_tok <> ''
       AND lower(COALESCE(g.last_name, g.full_name, '')) ILIKE ('%' || li.second_tok || '%')
        THEN 1
      WHEN li.second_tok = ''
       AND li.audience_hint IS NOT NULL
       AND contact_source_matches_audience(g.source, li.audience_hint)
        THEN 2
      WHEN li.second_tok = ''
        THEN 3
      ELSE 4
    END AS score
    FROM live li
    JOIN ghl_contacts g
      ON name_first_token(g.first_name) = li.first_tok
   WHERE NOT EXISTS (SELECT 1 FROM manual_match m WHERE m.closer_call_id = li.closer_call_id)
     AND NOT EXISTS (SELECT 1 FROM tf_matched   m WHERE m.closer_call_id = li.closer_call_id)
),
ghl_ranked AS (
  SELECT *,
         SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END)
           OVER (PARTITION BY closer_call_id) AS weak_count,
         ROW_NUMBER() OVER (
           PARTITION BY closer_call_id
           ORDER BY score ASC, date_added DESC NULLS LAST
         ) AS rn
    FROM ghl_candidates
),
ghl_matched AS (
  SELECT closer_call_id, display_name, landed_at, outcome,
         cash_collected, revenue,
         ghl_contact_id, email, phone, last_ad_id, first_ad_id,
         CASE
           WHEN score = 1 THEN 'medium'  -- GHL strong match is medium overall
           WHEN score = 2 THEN 'weak'
           ELSE 'weak'
         END AS match_confidence
    FROM ghl_ranked
   WHERE rn = 1
     AND (score IN (1, 2) OR (score = 3 AND weak_count = 1))
),
ghl_resolved AS (
  SELECT m.closer_call_id, m.display_name, m.landed_at, m.outcome,
         m.cash_collected, m.revenue,
         m.ghl_contact_id, m.email, m.phone,
         m.match_confidence,
         COALESCE(
           m.last_ad_id,
           m.first_ad_id,
           (SELECT t.ad_id
              FROM typeform_responses t
             WHERE t.ad_id IS NOT NULL
               AND ((m.email IS NOT NULL AND lower(t.email) = lower(m.email))
                 OR (m.phone IS NOT NULL AND t.phone = m.phone))
             ORDER BY t.submitted_at DESC NULLS LAST
             LIMIT 1)
         ) AS resolved_ad_id
    FROM ghl_matched m
),
combined AS (
  SELECT closer_call_id, display_name, landed_at, outcome,
         cash_collected, revenue,
         ad_id, adset_id, utm_campaign, match_confidence
    FROM manual_match
  UNION ALL
  SELECT closer_call_id, display_name, landed_at, outcome,
         cash_collected, revenue,
         tf_ad_id, tf_adset_id, tf_utm_campaign, match_confidence
    FROM tf_matched
   WHERE tf_ad_id IS NOT NULL OR tf_utm_campaign IS NOT NULL
  UNION ALL
  SELECT closer_call_id, display_name, landed_at, outcome,
         cash_collected, revenue,
         resolved_ad_id, NULL::text, NULL::text, match_confidence
    FROM ghl_resolved
   WHERE resolved_ad_id IS NOT NULL
)
SELECT c.closer_call_id,
       c.display_name,
       c.landed_at,
       c.outcome,
       c.cash_collected,
       c.revenue,
       c.ad_id,
       COALESCE(c.adset_id, a.adset_id) AS adset_id,
       COALESCE(c.utm_campaign, a.campaign_name) AS utm_campaign,
       c.match_confidence
  FROM combined c
  LEFT JOIN ads a ON a.ad_id = c.ad_id
 WHERE c.ad_id IS NOT NULL OR c.utm_campaign IS NOT NULL;

GRANT SELECT ON public.lib_ghl_lives_detail TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- lib_attribution_qa_queue
-- Surfaces every call (live and closed in the last 90 days) where the
-- resolver is not 100% confident. Three buckets:
--   - low confidence: weak match
--   - missing audience: attributed to an ad but parser says Unknown
--   - orphan: showed/closed but no attribution path produced an answer
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.lib_attribution_qa_queue AS
WITH all_attributed_lives AS (
  SELECT cc.id AS closer_call_id,
         cc.prospect_name,
         cc.created_at AS landed_at,
         cc.outcome,
         cc.revenue,
         cc.cash_collected,
         v.ad_id,
         v.utm_campaign,
         v.match_confidence,
         CASE WHEN cc.outcome::text = 'closed' THEN 'close' ELSE 'live' END AS row_type
    FROM closer_calls cc
    LEFT JOIN lib_ghl_lives_detail v ON v.closer_call_id = cc.id
   WHERE cc.created_at >= NOW() - INTERVAL '90 days'
     AND (cc.showed OR cc.outcome::text IN ('showed','closed','not_closed'))
),
flagged AS (
  SELECT closer_call_id, prospect_name, landed_at, outcome,
         revenue, cash_collected,
         ad_id, utm_campaign, row_type,
         CASE
           WHEN ad_id IS NULL AND utm_campaign IS NULL THEN 'orphan'
           WHEN match_confidence = 'weak' THEN 'low_confidence'
           WHEN COALESCE(
                  prospect_name_audience_title(prospect_name),
                  audience_from_campaign_name(utm_campaign)
                ) IS NULL THEN 'missing_audience'
           ELSE 'ok'
         END AS qa_flag,
         match_confidence,
         COALESCE(
           prospect_name_audience_title(prospect_name),
           audience_from_campaign_name(utm_campaign),
           'Unknown'
         ) AS current_audience
    FROM all_attributed_lives
)
SELECT closer_call_id,
       prospect_name,
       landed_at::date AS d,
       outcome,
       revenue,
       cash_collected,
       row_type,
       qa_flag,
       match_confidence,
       current_audience,
       ad_id,
       utm_campaign
  FROM flagged
 WHERE qa_flag <> 'ok'
 ORDER BY landed_at DESC;

GRANT SELECT ON public.lib_attribution_qa_queue TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
