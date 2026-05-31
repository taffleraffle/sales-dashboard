-- Consult close_attribution_overrides from lib_ghl_lives_detail too
-- (Ben 2026-06-01).
--
-- Today: close_attribution_overrides ONLY affects lib_close_resolved. So
-- when Ben marks Eric Campbell (5/21 closed) and Dennis Sullivan (4/30
-- ascended) as REFERRAL, only the closes drill-down sees it — the live
-- calls drill-down still shows them as unattributed.
--
-- Fix: prepend a manual-override path at the top of the lib_ghl_lives_
-- detail resolver. utm_campaign='REFERRAL' (or any manually-set value)
-- with ad_id=NULL means "not from ads" — these show in the page with the
-- override's utm_campaign as the campaign string, no ad_id.
--
-- This keeps a single source of truth (close_attribution_overrides) for
-- both live and close drill-downs.

BEGIN;

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
-- Manual override path — wins above everything else
manual_match AS (
  SELECT li.closer_call_id, li.display_name, li.landed_at, li.outcome,
         li.cash_collected, li.revenue,
         ov.ad_id, ov.adset_id, ov.utm_campaign
    FROM live li
    JOIN close_attribution_overrides ov ON ov.closer_call_id = li.closer_call_id
   WHERE ov.ad_id IS NOT NULL OR ov.utm_campaign IS NOT NULL
),
-- Typeform direct path
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
      ON LOWER(t.first_name) = li.first_tok
     AND t.submitted_at::date <= li.landed_at::date
     AND t.submitted_at::date >= (li.landed_at::date - INTERVAL '60 days')
   WHERE t.ad_id IS NOT NULL OR t.utm_campaign IS NOT NULL OR t.utm_term IS NOT NULL
     -- skip calls already resolved manually
     AND NOT EXISTS (SELECT 1 FROM manual_match m WHERE m.closer_call_id = li.closer_call_id)
),
tf_weak_stats AS (
  SELECT closer_call_id,
         COUNT(*) AS weak_count,
         COUNT(DISTINCT form_name) AS weak_form_count
    FROM tf_candidates
   WHERE score = 3
   GROUP BY closer_call_id
),
tf_ranked AS (
  SELECT c.*,
         COALESCE(s.weak_count, 0) AS weak_count,
         COALESCE(s.weak_form_count, 0) AS weak_form_count,
         ROW_NUMBER() OVER (
           PARTITION BY c.closer_call_id
           ORDER BY c.score ASC, c.submitted_at DESC
         ) AS rn
    FROM tf_candidates c
    LEFT JOIN tf_weak_stats s ON s.closer_call_id = c.closer_call_id
),
tf_matched AS (
  SELECT closer_call_id, display_name, landed_at, outcome,
         cash_collected, revenue,
         tf_ad_id, tf_utm_campaign, tf_adset_id
    FROM tf_ranked
   WHERE rn = 1
     AND (
       score IN (1, 2)
       OR (score = 3 AND weak_count = 1)
       OR (score = 3 AND weak_count > 1 AND weak_form_count = 1)
     )
),
-- GHL contact fallback
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
         ghl_contact_id, email, phone, last_ad_id, first_ad_id
    FROM ghl_ranked
   WHERE rn = 1
     AND (score IN (1, 2) OR (score = 3 AND weak_count = 1))
),
ghl_resolved AS (
  SELECT m.closer_call_id, m.display_name, m.landed_at, m.outcome,
         m.cash_collected, m.revenue,
         m.ghl_contact_id, m.email, m.phone,
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
  -- manual override (highest priority)
  SELECT m.closer_call_id, m.display_name, m.landed_at, m.outcome,
         m.cash_collected, m.revenue,
         m.ad_id, m.adset_id, m.utm_campaign
    FROM manual_match m
  UNION ALL
  -- typeform direct
  SELECT m.closer_call_id, m.display_name, m.landed_at, m.outcome,
         m.cash_collected, m.revenue,
         m.tf_ad_id, m.tf_adset_id, m.tf_utm_campaign
    FROM tf_matched m
   WHERE m.tf_ad_id IS NOT NULL OR m.tf_utm_campaign IS NOT NULL
  UNION ALL
  -- ghl fallback
  SELECT g.closer_call_id, g.display_name, g.landed_at, g.outcome,
         g.cash_collected, g.revenue,
         g.resolved_ad_id, NULL::text, NULL::text
    FROM ghl_resolved g
   WHERE g.resolved_ad_id IS NOT NULL
)
SELECT c.closer_call_id,
       c.display_name,
       c.landed_at,
       c.outcome,
       c.cash_collected,
       c.revenue,
       c.ad_id,
       COALESCE(c.adset_id, a.adset_id) AS adset_id,
       COALESCE(c.utm_campaign, a.campaign_name) AS utm_campaign
  FROM combined c
  LEFT JOIN ads a ON a.ad_id = c.ad_id
 WHERE c.ad_id IS NOT NULL OR c.utm_campaign IS NOT NULL;

GRANT SELECT ON public.lib_ghl_lives_detail TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
