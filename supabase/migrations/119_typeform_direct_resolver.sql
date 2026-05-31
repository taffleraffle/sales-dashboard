-- Direct Typeform attribution path (Ben 2026-06-01).
--
-- Ben's correction: stop going through GHL contacts. Typeform itself stores
-- the ad_id + utm_campaign + utm_content per response. Just match closer
-- calls to typeform submissions directly by first_name + date proximity.
--
-- This recovers 15 of the 18 previously unattributed live calls in the
-- last 30 days, including Hector (Electrician Funnel, 5/26 submission, 5/29
-- call) and Brian (Restoration Funnel, 5/4 submission, 5/11 call).
--
-- Strategy:
--   1. Find typeform_responses with matching first_name submitted within
--      60 days BEFORE the call
--   2. Score:
--        1 = first AND last name both match in typeform row
--        2 = first name + form_name aligns with the call's audience hint
--            (RestorationConnect → Restoration Funnel, etc.)
--        3 = first name only — accept only when EXACTLY ONE typeform Brian
--            submitted in the window
--   3. Prefer the most recent qualifying submission (tightest date proximity)
--
-- This path runs BEFORE the GHL-contact path in the final COALESCE so
-- typeform direct attribution wins when available.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- form_name_matches_audience — does a typeform form_name align with the
-- audience hint extracted from a call's calendar suffix?
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.form_name_matches_audience(form_name text, hint text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN hint IS NULL THEN false
    WHEN form_name IS NULL THEN false
    WHEN hint = 'restoration' THEN form_name ILIKE '%restoration%'
    WHEN hint = 'electrician' THEN form_name ILIKE '%electrician%'
    WHEN hint = 'remodeler'   THEN form_name ILIKE '%remodel%' OR form_name ILIKE '%restoration%'
    WHEN hint = 'service'     THEN form_name ILIKE '%restoration%' OR form_name ILIKE '%service%'
    ELSE false
  END
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- lib_ghl_lives_detail — adds typeform-direct attribution as top path
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
-- TYPEFORM DIRECT path: best signal, runs first
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
tf_ranked AS (
  SELECT *,
         SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END)
           OVER (PARTITION BY closer_call_id) AS weak_count,
         ROW_NUMBER() OVER (
           PARTITION BY closer_call_id
           ORDER BY score ASC, submitted_at DESC
         ) AS rn
    FROM tf_candidates
),
tf_matched AS (
  SELECT closer_call_id, display_name, landed_at, outcome,
         cash_collected, revenue,
         tf_ad_id, tf_utm_campaign, tf_adset_id
    FROM tf_ranked
   WHERE rn = 1
     AND (score IN (1, 2) OR (score = 3 AND weak_count = 1))
),
-- GHL CONTACT path: fallback for calls with no typeform match
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
    -- skip calls already matched via typeform
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
-- UNION: typeform-direct first, GHL fallback second
combined AS (
  -- typeform direct
  SELECT m.closer_call_id, m.display_name, m.landed_at, m.outcome,
         m.cash_collected, m.revenue,
         m.tf_ad_id AS ad_id,
         m.tf_adset_id AS adset_id,
         m.tf_utm_campaign AS utm_campaign,
         'typeform'::text AS attribution_source
    FROM tf_matched m
   WHERE m.tf_ad_id IS NOT NULL OR m.tf_utm_campaign IS NOT NULL
  UNION ALL
  -- ghl fallback (only when resolved_ad_id is set)
  SELECT g.closer_call_id, g.display_name, g.landed_at, g.outcome,
         g.cash_collected, g.revenue,
         g.resolved_ad_id AS ad_id,
         NULL::text AS adset_id,
         NULL::text AS utm_campaign,
         'ghl'::text AS attribution_source
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
