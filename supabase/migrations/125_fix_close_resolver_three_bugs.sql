-- Fix three bugs in lib_close_resolved that under-attributed Restoration
-- closes (Ben 2026-06-01).
--
-- Symptom: dashboard showed Restoration = 1 close in last 30 days, but
-- there were actually 4 (Tony, Vinicio, George Sidhom, Shain Mann) plus
-- 1 referral (Eric Campbell).
--
-- Bug 1 (Vinicio, George): typeform stores "Vinicio Guzman" and "George
-- Sidhom" as a single string in typeform_responses.first_name (last_name
-- column is NULL). The exact equality `LOWER(t.first_name) = cd.first_tok`
-- ("vinicio guzman" = "vinicio" → false) drops the match.
-- Fix: compare the first WORD of typeform first_name instead.
--
-- Bug 2 (George): his ghl_contacts row has no last_ad_id, first_ad_id,
-- utm_campaign, or form_name — just an email. So ghl_match fails. The
-- lib_ghl_lives_detail view has a typeform-via-email lateral that catches
-- this; lib_close_resolved doesn't.
-- Fix: add the same email-to-typeform lateral.
--
-- Bug 3 (Shain Mann): his ghl_contacts row has a STALE utm_campaign of
-- "Real- OPT 12/4" but his current last_ad_id is 120244658154470530 whose
-- ads.campaign_name is "OPT - ABO 3 ADSET 17/4" (which IS classified as
-- Restoration in campaign_audience_overrides). The resolver returned the
-- stale string and the audience parser said Unknown.
-- Fix: when ad_id is set, prefer ads.campaign_name (the live, post-rename
-- version) over the GHL contact's stored utm_campaign.

BEGIN;

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
-- TYPEFORM DIRECT (fix #1: use first WORD of typeform first_name)
tf_candidates AS (
  SELECT
    cd.closer_call_id, cd.audience_hint,
    t.ad_id, t.utm_term AS adset_id, t.utm_campaign,
    t.submitted_at, t.form_name,
    CASE
      WHEN cd.second_tok <> ''
       AND lower(COALESCE(t.last_name, '')) ILIKE ('%' || cd.second_tok || '%')
        THEN 1
      -- NEW: match by FIRST WORD of typeform first_name (handles
      -- "Vinicio Guzman" / "George Sidhom" stored in first_name)
      WHEN cd.second_tok <> ''
       AND lower(split_part(t.first_name, ' ', 2)) ILIKE ('%' || cd.second_tok || '%')
        THEN 1
      WHEN form_name_matches_audience(t.form_name, cd.audience_hint)
        THEN 2
      WHEN cd.second_tok = ''
        THEN 3
      ELSE 4
    END AS score
    FROM closed cd
    JOIN typeform_responses t
      ON lower(split_part(t.first_name, ' ', 1)) = cd.first_tok
     AND t.submitted_at::date <= cd.created_at::date
     AND t.submitted_at::date >= (cd.created_at::date - INTERVAL '60 days')
   WHERE t.ad_id IS NOT NULL OR t.utm_campaign IS NOT NULL OR t.utm_term IS NOT NULL
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
typeform_match AS (
  SELECT closer_call_id, ad_id, adset_id, utm_campaign
    FROM tf_ranked
   WHERE rn = 1
     AND (score IN (1, 2)
          OR (score = 3 AND weak_count = 1)
          OR (score = 3 AND weak_count > 1 AND weak_form_count = 1))
),
-- GHL CONTACT path (fix #2: add typeform-via-email fallback; fix #3:
-- carry ghl_contact's email/phone for the email->typeform lookup)
ghl_candidates AS (
  SELECT cd.closer_call_id, cd.audience_hint,
         g.email, g.phone,
         g.last_ad_id, g.first_ad_id, g.last_adset_id::text AS adset_id,
         COALESCE(g.last_utm_campaign, g.first_utm_campaign,
                  g.last_form_name, g.first_form_name) AS ghl_utm_campaign,
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
),
ghl_ranked AS (
  SELECT *,
         SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END) OVER (PARTITION BY closer_call_id) AS weak_count,
         ROW_NUMBER() OVER (PARTITION BY closer_call_id ORDER BY score, date_added DESC NULLS LAST) AS rn
    FROM ghl_candidates
),
ghl_match AS (
  -- Resolve ad_id by COALESCING the contact's own ids → typeform-via-email
  -- → null. This is the bit lib_close_resolved was missing.
  SELECT closer_call_id,
         COALESCE(
           last_ad_id,
           first_ad_id,
           (SELECT t.ad_id
              FROM typeform_responses t
             WHERE t.ad_id IS NOT NULL
               AND ((email IS NOT NULL AND lower(t.email) = lower(email))
                 OR (phone IS NOT NULL AND t.phone = phone))
             ORDER BY t.submitted_at DESC NULLS LAST
             LIMIT 1)
         ) AS ad_id,
         adset_id,
         ghl_utm_campaign AS utm_campaign
    FROM ghl_ranked
   WHERE rn = 1
     AND (score IN (1, 2) OR (score = 3 AND weak_count = 1))
),
-- HYROS unchanged
hy_candidates AS (
  SELECT cd.closer_call_id, cd.audience_hint,
         h.meta_ad_id AS ad_id, h.campaign_name, h.event_date,
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
    JOIN hyros_events h ON name_first_token(h.first_name::text) = cd.first_tok
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
-- Final SELECT: fix #3 — when ad_id is set, prefer ads.campaign_name
-- (current/live campaign) over the GHL contact's stale utm_campaign string.
SELECT cd.closer_call_id,
       cd.prospect_name,
       cd.clean_name,
       cd.revenue, cd.cash_collected, cd.created_at,
       COALESCE(ov.ad_id, tm.ad_id, gm.ad_id, hyros_ad.ad_id, ghl_ad.ad_id) AS resolved_ad_id,
       COALESCE(ov.adset_id, tm.adset_id, gm.adset_id, hyros_ad.adset_id, ghl_ad.adset_id) AS resolved_adset_id,
       COALESCE(
         ov.utm_campaign,
         tm.utm_campaign,
         -- prefer ad's live campaign_name when we have an ad_id
         ghl_ad.campaign_name,
         hyros_ad.campaign_name,
         gm.utm_campaign,
         hm.campaign_name::text
       ) AS resolved_campaign,
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
