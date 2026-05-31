-- Email-via-appointment resolver path (Ben 2026-06-01).
--
-- Ben's frustration: "how do you not know any of these, bro- Look at the
-- email that's invited to that event and then cross-reference it with
-- typeform, and it'll tell you everything you need to know."
--
-- He's right. closer_calls has no email, but every call was BOOKED in GHL
-- first. ghl_appointments has contact_email and matches closer_calls by
-- name + appointment_date. Then typeform_responses matches by email and
-- carries the ad_id.
--
-- New resolver path inserted at the TOP of lib_ghl_lives_detail:
--   1. manual override (close_attribution_overrides)
--   2. NEW: closer_call -> ghl_appointment (by first name + date proximity)
--           -> typeform_responses (by email) -> ad_id
--   3. typeform direct (existing first+last name match)
--   4. GHL contact fallback
--
-- This is HIGH confidence because the chain is two exact email matches,
-- not name fuzzing. Marked as 'strong' regardless of which name token
-- matched the appointment, because the email lookup downstream is exact.

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
manual_match AS (
  SELECT li.closer_call_id, li.display_name, li.landed_at, li.outcome,
         li.cash_collected, li.revenue,
         ov.ad_id, ov.adset_id, ov.utm_campaign,
         'manual'::text AS match_confidence
    FROM live li
    JOIN close_attribution_overrides ov ON ov.closer_call_id = li.closer_call_id
   WHERE ov.ad_id IS NOT NULL OR ov.utm_campaign IS NOT NULL
),
-- NEW: appointment -> typeform via email. Two-hop exact email chain.
appt_chain AS (
  SELECT DISTINCT ON (li.closer_call_id)
         li.closer_call_id, li.display_name, li.landed_at, li.outcome,
         li.cash_collected, li.revenue,
         t.ad_id, t.utm_term AS adset_id, t.utm_campaign,
         'strong'::text AS match_confidence
    FROM live li
    JOIN ghl_appointments ap
      ON ap.appointment_date::date BETWEEN li.landed_at::date - INTERVAL '7 days'
                                       AND li.landed_at::date + INTERVAL '2 days'
     AND lower(ap.contact_name) ILIKE (li.first_tok || '%')
     AND ap.contact_email IS NOT NULL
    JOIN typeform_responses t
      ON lower(t.email) = lower(ap.contact_email)
   WHERE (t.ad_id IS NOT NULL OR t.utm_campaign IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM manual_match m WHERE m.closer_call_id = li.closer_call_id)
   ORDER BY li.closer_call_id, t.submitted_at DESC NULLS LAST
),
-- Existing typeform-direct path (for calls without an appointment match)
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
   WHERE (t.ad_id IS NOT NULL OR t.utm_campaign IS NOT NULL OR t.utm_term IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM manual_match m WHERE m.closer_call_id = li.closer_call_id)
     AND NOT EXISTS (SELECT 1 FROM appt_chain   m WHERE m.closer_call_id = li.closer_call_id)
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
         CASE
           WHEN score = 1 THEN 'strong'
           WHEN score = 2 THEN 'medium'
           ELSE 'weak'
         END AS match_confidence
    FROM tf_ranked
   WHERE rn = 1
     AND (score IN (1, 2)
          OR (score = 3 AND weak_count = 1)
          OR (score = 3 AND weak_count > 1 AND weak_form_count = 1))
),
-- GHL contact fallback (unchanged)
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
      WHEN li.second_tok = '' THEN 3
      ELSE 4
    END AS score
    FROM live li
    JOIN ghl_contacts g ON name_first_token(g.first_name) = li.first_tok
   WHERE NOT EXISTS (SELECT 1 FROM manual_match m WHERE m.closer_call_id = li.closer_call_id)
     AND NOT EXISTS (SELECT 1 FROM appt_chain   m WHERE m.closer_call_id = li.closer_call_id)
     AND NOT EXISTS (SELECT 1 FROM tf_matched   m WHERE m.closer_call_id = li.closer_call_id)
),
ghl_ranked AS (
  SELECT *,
         SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END) OVER (PARTITION BY closer_call_id) AS weak_count,
         ROW_NUMBER() OVER (PARTITION BY closer_call_id ORDER BY score, date_added DESC NULLS LAST) AS rn
    FROM ghl_candidates
),
ghl_matched AS (
  SELECT closer_call_id, display_name, landed_at, outcome,
         cash_collected, revenue,
         ghl_contact_id, email, phone, last_ad_id, first_ad_id,
         CASE WHEN score = 1 THEN 'medium' ELSE 'weak' END AS match_confidence
    FROM ghl_ranked
   WHERE rn = 1 AND (score IN (1,2) OR (score = 3 AND weak_count = 1))
),
ghl_resolved AS (
  SELECT m.closer_call_id, m.display_name, m.landed_at, m.outcome,
         m.cash_collected, m.revenue, m.match_confidence,
         COALESCE(
           m.last_ad_id,
           m.first_ad_id,
           (SELECT t.ad_id FROM typeform_responses t
             WHERE t.ad_id IS NOT NULL
               AND ((m.email IS NOT NULL AND lower(t.email) = lower(m.email))
                 OR (m.phone IS NOT NULL AND t.phone = m.phone))
             ORDER BY t.submitted_at DESC NULLS LAST
             LIMIT 1)
         ) AS resolved_ad_id
    FROM ghl_matched m
),
combined AS (
  SELECT closer_call_id, display_name, landed_at, outcome, cash_collected, revenue,
         ad_id, adset_id, utm_campaign, match_confidence FROM manual_match
  UNION ALL
  SELECT closer_call_id, display_name, landed_at, outcome, cash_collected, revenue,
         ad_id, adset_id, utm_campaign, match_confidence FROM appt_chain
  UNION ALL
  SELECT closer_call_id, display_name, landed_at, outcome, cash_collected, revenue,
         tf_ad_id, tf_adset_id, tf_utm_campaign, match_confidence FROM tf_matched
   WHERE tf_ad_id IS NOT NULL OR tf_utm_campaign IS NOT NULL
  UNION ALL
  SELECT closer_call_id, display_name, landed_at, outcome, cash_collected, revenue,
         resolved_ad_id, NULL::text, NULL::text, match_confidence FROM ghl_resolved
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

-- Apply the same chain to lib_close_resolved so closes lift the same way.

CREATE OR REPLACE VIEW public.lib_close_resolved AS
WITH closed AS (
  SELECT c.id AS closer_call_id, c.prospect_name,
         strip_call_suffix(c.prospect_name::text) AS clean_name,
         name_first_token(strip_call_suffix(c.prospect_name::text))  AS first_tok,
         name_second_token(strip_call_suffix(c.prospect_name::text)) AS second_tok,
         audience_from_prospect_name(c.prospect_name::text)          AS audience_hint,
         c.revenue, c.cash_collected, c.created_at
    FROM closer_calls c
   WHERE c.outcome::text = 'closed'
),
-- NEW: same appointment-email chain
appt_chain AS (
  SELECT DISTINCT ON (cd.closer_call_id)
         cd.closer_call_id, t.ad_id, t.utm_term AS adset_id, t.utm_campaign
    FROM closed cd
    JOIN ghl_appointments ap
      ON ap.appointment_date::date BETWEEN cd.created_at::date - INTERVAL '7 days'
                                       AND cd.created_at::date + INTERVAL '2 days'
     AND lower(ap.contact_name) ILIKE (cd.first_tok || '%')
     AND ap.contact_email IS NOT NULL
    JOIN typeform_responses t ON lower(t.email) = lower(ap.contact_email)
   WHERE t.ad_id IS NOT NULL OR t.utm_campaign IS NOT NULL
   ORDER BY cd.closer_call_id, t.submitted_at DESC NULLS LAST
),
tf_candidates AS (
  SELECT cd.closer_call_id, cd.audience_hint,
         t.ad_id, t.utm_term AS adset_id, t.utm_campaign,
         t.submitted_at, t.form_name,
         CASE
           WHEN cd.second_tok <> ''
            AND lower(COALESCE(t.last_name, '')) ILIKE ('%' || cd.second_tok || '%') THEN 1
           WHEN cd.second_tok <> ''
            AND lower(split_part(t.first_name, ' ', 2)) ILIKE ('%' || cd.second_tok || '%') THEN 1
           WHEN form_name_matches_audience(t.form_name, cd.audience_hint) THEN 2
           WHEN cd.second_tok = '' THEN 3
           ELSE 4
         END AS score
    FROM closed cd
    JOIN typeform_responses t
      ON lower(split_part(t.first_name, ' ', 1)) = cd.first_tok
     AND t.submitted_at::date <= cd.created_at::date
     AND t.submitted_at::date >= (cd.created_at::date - INTERVAL '60 days')
   WHERE (t.ad_id IS NOT NULL OR t.utm_campaign IS NOT NULL OR t.utm_term IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM appt_chain a WHERE a.closer_call_id = cd.closer_call_id)
),
tf_weak_stats AS (
  SELECT closer_call_id, COUNT(*) AS weak_count, COUNT(DISTINCT form_name) AS weak_form_count
    FROM tf_candidates WHERE score = 3 GROUP BY closer_call_id
),
tf_ranked AS (
  SELECT c.*,
         COALESCE(s.weak_count, 0) AS weak_count,
         COALESCE(s.weak_form_count, 0) AS weak_form_count,
         ROW_NUMBER() OVER (PARTITION BY c.closer_call_id ORDER BY c.score, c.submitted_at DESC) AS rn
    FROM tf_candidates c LEFT JOIN tf_weak_stats s ON s.closer_call_id = c.closer_call_id
),
typeform_match AS (
  SELECT closer_call_id, ad_id, adset_id, utm_campaign FROM tf_ranked
   WHERE rn = 1
     AND (score IN (1,2)
          OR (score = 3 AND weak_count = 1)
          OR (score = 3 AND weak_count > 1 AND weak_form_count = 1))
),
ghl_candidates AS (
  SELECT cd.closer_call_id, cd.audience_hint, g.email, g.phone,
         g.last_ad_id, g.first_ad_id, g.last_adset_id::text AS adset_id,
         COALESCE(g.last_utm_campaign, g.first_utm_campaign,
                  g.last_form_name, g.first_form_name) AS ghl_utm_campaign,
         g.date_added, g.source,
         CASE
           WHEN cd.second_tok <> ''
            AND lower(COALESCE(g.last_name, g.full_name, '')) ILIKE ('%' || cd.second_tok || '%') THEN 1
           WHEN cd.second_tok = ''
            AND cd.audience_hint IS NOT NULL
            AND contact_source_matches_audience(g.source, cd.audience_hint) THEN 2
           WHEN cd.second_tok = '' THEN 3
           ELSE 4
         END AS score
    FROM closed cd
    JOIN ghl_contacts g ON name_first_token(g.first_name) = cd.first_tok
   WHERE NOT EXISTS (SELECT 1 FROM appt_chain a WHERE a.closer_call_id = cd.closer_call_id)
     AND NOT EXISTS (SELECT 1 FROM typeform_match m WHERE m.closer_call_id = cd.closer_call_id)
),
ghl_ranked AS (
  SELECT *,
         SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END) OVER (PARTITION BY closer_call_id) AS weak_count,
         ROW_NUMBER() OVER (PARTITION BY closer_call_id ORDER BY score, date_added DESC NULLS LAST) AS rn
    FROM ghl_candidates
),
ghl_match AS (
  SELECT closer_call_id,
         COALESCE(last_ad_id, first_ad_id,
           (SELECT t.ad_id FROM typeform_responses t
             WHERE t.ad_id IS NOT NULL
               AND ((email IS NOT NULL AND lower(t.email) = lower(email))
                 OR (phone IS NOT NULL AND t.phone = phone))
             ORDER BY t.submitted_at DESC NULLS LAST LIMIT 1)
         ) AS ad_id,
         adset_id,
         ghl_utm_campaign AS utm_campaign
    FROM ghl_ranked
   WHERE rn = 1 AND (score IN (1,2) OR (score = 3 AND weak_count = 1))
),
hy_candidates AS (
  SELECT cd.closer_call_id, cd.audience_hint,
         h.meta_ad_id AS ad_id, h.campaign_name, h.event_date,
         CASE
           WHEN cd.second_tok <> ''
            AND lower(COALESCE(h.last_name, ''::varchar)::text) ILIKE (cd.second_tok || '%') THEN 1
           WHEN cd.second_tok = ''
            AND cd.audience_hint IS NOT NULL
            AND contact_source_matches_audience(h.campaign_name::text, cd.audience_hint) THEN 2
           WHEN cd.second_tok = '' THEN 3
           ELSE 4
         END AS score
    FROM closed cd
    JOIN hyros_events h ON name_first_token(h.first_name::text) = cd.first_tok
   WHERE h.meta_ad_id IS NOT NULL OR h.campaign_name IS NOT NULL
),
hy_ranked AS (
  SELECT *, SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END) OVER (PARTITION BY closer_call_id) AS weak_count,
         ROW_NUMBER() OVER (PARTITION BY closer_call_id ORDER BY score, event_date DESC) AS rn FROM hy_candidates
),
hyros_match AS (
  SELECT closer_call_id, ad_id, campaign_name FROM hy_ranked
   WHERE rn = 1 AND (score IN (1,2) OR (score = 3 AND weak_count = 1))
)
SELECT cd.closer_call_id, cd.prospect_name, cd.clean_name,
       cd.revenue, cd.cash_collected, cd.created_at,
       COALESCE(ov.ad_id, ac.ad_id, tm.ad_id, gm.ad_id, hyros_ad.ad_id, ghl_ad.ad_id) AS resolved_ad_id,
       COALESCE(ov.adset_id, ac.adset_id, tm.adset_id, gm.adset_id, hyros_ad.adset_id, ghl_ad.adset_id) AS resolved_adset_id,
       COALESCE(
         ov.utm_campaign,
         ac.utm_campaign,
         tm.utm_campaign,
         ghl_ad.campaign_name,
         hyros_ad.campaign_name,
         gm.utm_campaign,
         hm.campaign_name::text
       ) AS resolved_campaign,
       CASE
         WHEN ov.closer_call_id IS NOT NULL THEN 'manual'
         WHEN ac.closer_call_id IS NOT NULL THEN 'appointment'
         WHEN tm.closer_call_id IS NOT NULL THEN 'typeform'
         WHEN gm.closer_call_id IS NOT NULL THEN 'ghl'
         WHEN hm.closer_call_id IS NOT NULL THEN 'hyros'
         ELSE 'orphan'
       END AS attribution_source
  FROM closed cd
  LEFT JOIN close_attribution_overrides ov ON ov.closer_call_id = cd.closer_call_id
  LEFT JOIN appt_chain ac ON ac.closer_call_id = cd.closer_call_id
  LEFT JOIN typeform_match tm ON tm.closer_call_id = cd.closer_call_id
  LEFT JOIN ghl_match gm ON gm.closer_call_id = cd.closer_call_id
  LEFT JOIN hyros_match hm ON hm.closer_call_id = cd.closer_call_id
  LEFT JOIN LATERAL (SELECT a.ad_id, a.adset_id, a.campaign_name FROM ads a WHERE a.ad_id = hm.ad_id LIMIT 1) hyros_ad ON true
  LEFT JOIN LATERAL (SELECT a.ad_id, a.adset_id, a.campaign_name FROM ads a WHERE a.ad_id = gm.ad_id LIMIT 1) ghl_ad   ON true;

GRANT SELECT ON public.lib_close_resolved TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
