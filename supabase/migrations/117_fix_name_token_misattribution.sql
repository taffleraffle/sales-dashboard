-- Fix the name-token resolver in lib_ghl_lives_detail + lib_close_resolved
-- (Ben 2026-06-01).
--
-- Bug: when a closer_call's prospect_name has no last name (e.g. just
-- "Brian", or "Brian - RestorationConnect Strategy Call" which strips to
-- "Brian"), name_second_token returns ''. The previous JOIN allowed this
-- via `(second_tok = '' OR last_name_match)` — meaning the OR short-
-- circuits to TRUE and the matcher accepts EVERY ghl_contact with that
-- first name. The DISTINCT ON / ORDER BY date_added DESC then picks the
-- most-recently-added contact. So a Restoration "Brian" call gets matched
-- to whichever Brian was most recently added — which on 2026-05-31 was
-- "Brian Brayboy" from the Electrician Funnel.
--
-- Live example Ben caught: "Brian - RestorationConnect Strategy Call" on
-- 2026-05-11 attributed to "SCIO - Electricians - VSL - #1 Electrician
-- 5/24 - Relaunch" via Brian Brayboy's Electrician Typeform → ad_id.
-- The real RestorationConnect Brian is in ghl_contacts as a separate
-- email (callcarolinawater@gmail.com) tied to the SCIO Restoration
-- Application campaign.
--
-- Fix: require second_tok to be NON-EMPTY for a match. Single-token
-- prospect names become unattributed — better to be honest than wrong.
-- The drilldown shows them in the "no ad attribution" banner where Ben
-- can manually link via close_attribution_overrides if needed.
--
-- The buggy pattern also lives in lib_close_resolved's three sub-matches
-- (typeform_match, ghl_match, hyros_match) — all fixed.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- lib_ghl_lives_detail
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.lib_ghl_lives_detail AS
WITH live AS (
  SELECT cc.id AS closer_call_id,
         cc.prospect_name AS display_name,
         cc.created_at AS landed_at,
         cc.outcome,
         cc.cash_collected,
         cc.revenue,
         name_first_token(strip_call_suffix(cc.prospect_name::text))  AS first_tok,
         name_second_token(strip_call_suffix(cc.prospect_name::text)) AS second_tok
    FROM closer_calls cc
   WHERE cc.showed = true
      OR (cc.outcome::text = ANY (ARRAY['showed','closed','not_closed']::text[]))
),
matched AS (
  SELECT DISTINCT ON (li.closer_call_id)
         li.closer_call_id,
         li.display_name,
         li.landed_at,
         li.outcome,
         li.cash_collected,
         li.revenue,
         g.ghl_contact_id,
         g.email,
         g.phone,
         COALESCE(
           g.last_ad_id,
           g.first_ad_id,
           (SELECT t.ad_id
              FROM typeform_responses t
             WHERE t.ad_id IS NOT NULL
               AND (
                 (g.email IS NOT NULL AND lower(t.email) = lower(g.email))
                 OR (g.phone IS NOT NULL AND t.phone = g.phone)
               )
             ORDER BY t.submitted_at DESC NULLS LAST
             LIMIT 1)
         ) AS resolved_ad_id
    FROM live li
    JOIN ghl_contacts g
      ON name_first_token(g.first_name) = li.first_tok
     -- NEW: require last name token to be non-empty AND match. Drops
     -- single-token call names to unattributed rather than wrong.
     AND li.second_tok <> ''
     AND lower(COALESCE(g.last_name, g.full_name, '')) ILIKE ('%' || li.second_tok || '%')
   ORDER BY li.closer_call_id, g.date_added DESC NULLS LAST
)
SELECT m.closer_call_id,
       m.display_name,
       m.landed_at,
       m.outcome,
       m.cash_collected,
       m.revenue,
       m.resolved_ad_id  AS ad_id,
       a.adset_id,
       a.campaign_name   AS utm_campaign
  FROM matched m
  LEFT JOIN ads a ON a.ad_id = m.resolved_ad_id
 WHERE m.resolved_ad_id IS NOT NULL;

GRANT SELECT ON public.lib_ghl_lives_detail TO anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- lib_close_resolved — same fix applied to typeform_match, ghl_match,
-- hyros_match sub-CTEs.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.lib_close_resolved AS
WITH closed AS (
  SELECT c.id AS closer_call_id,
         c.prospect_name,
         strip_call_suffix(c.prospect_name::text) AS clean_name,
         name_first_token(strip_call_suffix(c.prospect_name::text))  AS first_tok,
         name_second_token(strip_call_suffix(c.prospect_name::text)) AS second_tok,
         c.revenue,
         c.cash_collected,
         c.created_at
    FROM closer_calls c
   WHERE c.outcome::text = 'closed'
),
typeform_match AS (
  SELECT DISTINCT ON (cd.closer_call_id) cd.closer_call_id,
         tfr.ad_id,
         tfr.utm_term AS adset_id,
         tfr.utm_campaign
    FROM closed cd
    JOIN typeform_responses tfr
      ON name_first_token(tfr.first_name) = cd.first_tok
     AND cd.second_tok <> ''
     AND lower(COALESCE(tfr.last_name, tfr.first_name, '')) ILIKE ('%' || cd.second_tok || '%')
   WHERE tfr.ad_id IS NOT NULL OR tfr.utm_term IS NOT NULL OR tfr.utm_campaign IS NOT NULL
   ORDER BY cd.closer_call_id, tfr.submitted_at DESC NULLS LAST
),
ghl_match AS (
  SELECT DISTINCT ON (cd.closer_call_id) cd.closer_call_id,
         COALESCE(g.last_ad_id, g.first_ad_id) AS ad_id,
         COALESCE(g.last_adset_id, NULL::text) AS adset_id,
         COALESCE(g.last_utm_campaign, g.first_utm_campaign, g.last_form_name, g.first_form_name) AS utm_campaign
    FROM closed cd
    JOIN ghl_contacts g
      ON name_first_token(g.first_name) = cd.first_tok
     AND cd.second_tok <> ''
     AND lower(COALESCE(g.last_name, g.full_name, '')) ILIKE ('%' || cd.second_tok || '%')
   WHERE g.last_ad_id IS NOT NULL OR g.first_ad_id IS NOT NULL
      OR g.last_utm_campaign IS NOT NULL OR g.first_utm_campaign IS NOT NULL
      OR g.last_form_name IS NOT NULL OR g.first_form_name IS NOT NULL
   ORDER BY cd.closer_call_id, g.date_added DESC NULLS LAST
),
hyros_match AS (
  SELECT DISTINCT ON (cd.closer_call_id) cd.closer_call_id,
         h.meta_ad_id AS ad_id,
         h.campaign_name
    FROM closed cd
    JOIN hyros_events h
      ON name_first_token(h.first_name::text) = cd.first_tok
     AND cd.second_tok <> ''
     AND lower(COALESCE(h.last_name, ''::varchar)::text) ILIKE (cd.second_tok || '%')
   WHERE h.meta_ad_id IS NOT NULL OR h.campaign_name IS NOT NULL
   ORDER BY cd.closer_call_id, h.event_date DESC
)
SELECT cd.closer_call_id,
       cd.prospect_name,
       cd.clean_name,
       cd.revenue,
       cd.cash_collected,
       cd.created_at,
       COALESCE(ov.ad_id,        tm.ad_id,      gm.ad_id,      hyros_ad.ad_id, ghl_ad.ad_id) AS resolved_ad_id,
       COALESCE(ov.adset_id,     tm.adset_id,   gm.adset_id,   hyros_ad.adset_id, ghl_ad.adset_id) AS resolved_adset_id,
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
  LEFT JOIN typeform_match tm                 ON tm.closer_call_id = cd.closer_call_id
  LEFT JOIN ghl_match       gm                ON gm.closer_call_id = cd.closer_call_id
  LEFT JOIN hyros_match     hm                ON hm.closer_call_id = cd.closer_call_id
  LEFT JOIN LATERAL (SELECT a.ad_id, a.adset_id, a.campaign_name FROM ads a WHERE a.ad_id = hm.ad_id LIMIT 1) hyros_ad ON true
  LEFT JOIN LATERAL (SELECT a.ad_id, a.adset_id, a.campaign_name FROM ads a WHERE a.ad_id = gm.ad_id LIMIT 1) ghl_ad   ON true;

GRANT SELECT ON public.lib_close_resolved TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
