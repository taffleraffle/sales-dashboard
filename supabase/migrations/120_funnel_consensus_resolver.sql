-- Funnel-consensus relaxation + apply Typeform-direct to closes
-- (Ben 2026-06-01).
--
-- Two improvements on top of 118+119:
--
-- 1. Weak-match relaxation:
--    Previously, when a closer call had only a first name to match by AND
--    multiple typeform candidates existed, we dropped to unattributed.
--    But if ALL candidates share the same form_name (all "Restoration
--    Funnel", all "Electrician Funnel", etc.), the audience is unambiguous
--    even though the specific lead is unclear. Take the most recent
--    submission as the attribution — it's the lead most likely sitting on
--    the closer's calendar.
--    Worked example: "Mike (5/5) call" has 4 Mike typeforms in window, all
--    Restoration Funnel. Pick Mike White (5/6) as the most-recent
--    submission. Confidence is high enough.
--    Drops to NULL only when form_names DISAGREE (e.g. one Restoration +
--    one Electrician Mike) — that's a genuine audience-level ambiguity.
--
-- 2. Apply Typeform-direct path to lib_close_resolved (closes attribution)
--    so closes lift from GHL-only to typeform-direct, same as live calls.
--
-- This makes the resolver durable for ANY future client/call: the rules
-- only depend on typeform_responses + closer_calls + ghl_contacts, all of
-- which are kept fresh by the auto- cron jobs.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- lib_ghl_lives_detail — relax weak match
-- ───────────────────────────────────────────────────────────────────────────

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
),
-- Pre-aggregate weak-candidate stats per call (Postgres window funcs don't
-- support COUNT(DISTINCT), so do it in a separate aggregate CTE then join).
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
       -- NEW: accept weak match when multiple candidates exist AND they all
       -- share the same form_name. Most-recent submission wins (rn = 1).
       OR (score = 3 AND weak_count > 1 AND weak_form_count = 1)
     )
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
   WHERE NOT EXISTS (SELECT 1 FROM tf_matched m WHERE m.closer_call_id = li.closer_call_id)
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
  SELECT m.closer_call_id, m.display_name, m.landed_at, m.outcome,
         m.cash_collected, m.revenue,
         m.tf_ad_id AS ad_id,
         m.tf_adset_id AS adset_id,
         m.tf_utm_campaign AS utm_campaign
    FROM tf_matched m
   WHERE m.tf_ad_id IS NOT NULL OR m.tf_utm_campaign IS NOT NULL
  UNION ALL
  SELECT g.closer_call_id, g.display_name, g.landed_at, g.outcome,
         g.cash_collected, g.revenue,
         g.resolved_ad_id AS ad_id,
         NULL::text AS adset_id,
         NULL::text AS utm_campaign
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

-- ───────────────────────────────────────────────────────────────────────────
-- lib_close_resolved — same typeform-direct + funnel-consensus path
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.lib_close_resolved AS
WITH closed AS (
  SELECT c.id AS closer_call_id,
         c.prospect_name,
         strip_call_suffix(c.prospect_name::text) AS clean_name,
         name_first_token(strip_call_suffix(c.prospect_name::text))  AS first_tok,
         name_second_token(strip_call_suffix(c.prospect_name::text)) AS second_tok,
         audience_from_prospect_name(c.prospect_name::text)          AS audience_hint,
         c.revenue, c.cash_collected, c.created_at
    FROM closer_calls c
   WHERE c.outcome::text = 'closed'
),
-- Typeform direct (same ladder as lives)
tf_candidates AS (
  SELECT
    cd.closer_call_id, cd.audience_hint,
    t.ad_id, t.utm_term AS adset_id, t.utm_campaign,
    t.submitted_at, t.form_name,
    CASE
      WHEN cd.second_tok <> ''
       AND lower(COALESCE(t.last_name, '')) ILIKE ('%' || cd.second_tok || '%')
        THEN 1
      WHEN form_name_matches_audience(t.form_name, cd.audience_hint)
        THEN 2
      WHEN cd.second_tok = ''
        THEN 3
      ELSE 4
    END AS score
    FROM closed cd
    JOIN typeform_responses t
      ON LOWER(t.first_name) = cd.first_tok
     AND t.submitted_at::date <= cd.created_at::date
     AND t.submitted_at::date >= (cd.created_at::date - INTERVAL '60 days')
   WHERE t.ad_id IS NOT NULL OR t.utm_campaign IS NOT NULL OR t.utm_term IS NOT NULL
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
         ROW_NUMBER() OVER (PARTITION BY c.closer_call_id ORDER BY c.score, c.submitted_at DESC) AS rn
    FROM tf_candidates c
    LEFT JOIN tf_weak_stats s ON s.closer_call_id = c.closer_call_id
),
typeform_match AS (
  SELECT closer_call_id, ad_id, adset_id, utm_campaign
    FROM tf_ranked
   WHERE rn = 1
     AND (
       score IN (1, 2)
       OR (score = 3 AND weak_count = 1)
       OR (score = 3 AND weak_count > 1 AND weak_form_count = 1)
     )
),
-- GHL fallback (carried over from previous version; same ladder)
ghl_candidates AS (
  SELECT cd.closer_call_id, cd.audience_hint,
         COALESCE(g.last_ad_id, g.first_ad_id) AS ad_id,
         g.last_adset_id::text AS adset_id,
         COALESCE(g.last_utm_campaign, g.first_utm_campaign, g.last_form_name, g.first_form_name) AS utm_campaign,
         g.date_added, g.source,
         CASE
           WHEN cd.second_tok <> ''
            AND lower(COALESCE(g.last_name, g.full_name, '')) ILIKE ('%' || cd.second_tok || '%')
             THEN 1
           WHEN cd.second_tok = ''
            AND cd.audience_hint IS NOT NULL
            AND contact_source_matches_audience(g.source, cd.audience_hint)
             THEN 2
           WHEN cd.second_tok = '' THEN 3
           ELSE 4
         END AS score
    FROM closed cd
    JOIN ghl_contacts g
      ON name_first_token(g.first_name) = cd.first_tok
   WHERE NOT EXISTS (SELECT 1 FROM typeform_match m WHERE m.closer_call_id = cd.closer_call_id)
     AND (g.last_ad_id IS NOT NULL OR g.first_ad_id IS NOT NULL
       OR g.last_utm_campaign IS NOT NULL OR g.first_utm_campaign IS NOT NULL
       OR g.last_form_name IS NOT NULL OR g.first_form_name IS NOT NULL)
),
ghl_ranked AS (
  SELECT *,
         SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END) OVER (PARTITION BY closer_call_id) AS weak_count,
         ROW_NUMBER() OVER (PARTITION BY closer_call_id ORDER BY score, date_added DESC NULLS LAST) AS rn
    FROM ghl_candidates
),
ghl_match AS (
  SELECT closer_call_id, ad_id, adset_id, utm_campaign
    FROM ghl_ranked
   WHERE rn = 1 AND (score IN (1,2) OR (score = 3 AND weak_count = 1))
),
hy_candidates AS (
  SELECT cd.closer_call_id, cd.audience_hint,
         h.meta_ad_id AS ad_id, h.campaign_name,
         h.event_date,
         CASE
           WHEN cd.second_tok <> ''
            AND lower(COALESCE(h.last_name, ''::varchar)::text) ILIKE (cd.second_tok || '%')
             THEN 1
           WHEN cd.second_tok = ''
            AND cd.audience_hint IS NOT NULL
            AND contact_source_matches_audience(h.campaign_name::text, cd.audience_hint)
             THEN 2
           WHEN cd.second_tok = '' THEN 3
           ELSE 4
         END AS score
    FROM closed cd
    JOIN hyros_events h
      ON name_first_token(h.first_name::text) = cd.first_tok
   WHERE h.meta_ad_id IS NOT NULL OR h.campaign_name IS NOT NULL
),
hy_ranked AS (
  SELECT *,
         SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END) OVER (PARTITION BY closer_call_id) AS weak_count,
         ROW_NUMBER() OVER (PARTITION BY closer_call_id ORDER BY score, event_date DESC) AS rn
    FROM hy_candidates
),
hyros_match AS (
  SELECT closer_call_id, ad_id, campaign_name
    FROM hy_ranked
   WHERE rn = 1 AND (score IN (1,2) OR (score = 3 AND weak_count = 1))
)
SELECT cd.closer_call_id,
       cd.prospect_name,
       cd.clean_name,
       cd.revenue, cd.cash_collected, cd.created_at,
       COALESCE(ov.ad_id, tm.ad_id, gm.ad_id, hyros_ad.ad_id, ghl_ad.ad_id) AS resolved_ad_id,
       COALESCE(ov.adset_id, tm.adset_id, gm.adset_id, hyros_ad.adset_id, ghl_ad.adset_id) AS resolved_adset_id,
       COALESCE(ov.utm_campaign, tm.utm_campaign, gm.utm_campaign,
                hm.campaign_name::text, hyros_ad.campaign_name, ghl_ad.campaign_name) AS resolved_campaign,
       CASE
         WHEN ov.closer_call_id IS NOT NULL THEN 'manual'
         WHEN tm.closer_call_id IS NOT NULL THEN 'typeform'
         WHEN gm.closer_call_id IS NOT NULL THEN 'ghl'
         WHEN hm.closer_call_id IS NOT NULL THEN 'hyros'
         ELSE 'orphan'
       END AS attribution_source
  FROM closed cd
  LEFT JOIN close_attribution_overrides ov ON ov.closer_call_id = cd.closer_call_id
  LEFT JOIN typeform_match tm                ON tm.closer_call_id = cd.closer_call_id
  LEFT JOIN ghl_match       gm               ON gm.closer_call_id = cd.closer_call_id
  LEFT JOIN hyros_match     hm               ON hm.closer_call_id = cd.closer_call_id
  LEFT JOIN LATERAL (SELECT a.ad_id, a.adset_id, a.campaign_name FROM ads a WHERE a.ad_id = hm.ad_id LIMIT 1) hyros_ad ON true
  LEFT JOIN LATERAL (SELECT a.ad_id, a.adset_id, a.campaign_name FROM ads a WHERE a.ad_id = gm.ad_id LIMIT 1) ghl_ad   ON true;

GRANT SELECT ON public.lib_close_resolved TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
