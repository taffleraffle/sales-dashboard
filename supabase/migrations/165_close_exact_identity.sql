-- 165: exact-identity close attribution (Ben audit, 2026-07-20).
--
-- The close resolver fuzzy-matched appointments by first-name token + a date
-- window (appt_chain), then fell back to pure first-name typeform/ghl/hyros
-- matching. Two prospects sharing a first name (e.g. two Jeremys) could take
-- each other's ad/audience — the "close first-name collisions" the audit flagged.
--
-- But the closer's EOD row already carries closer_calls.ghl_event_id, the exact
-- appointment the call belongs to. This adds event_chain: ghl_event_id ->
-- appointment -> its email/phone -> typeform ad. Exact identity, no name guess.
-- It sits directly below the manual override (Ben's corrections still win) and
-- ABOVE every fuzzy path, so where an event link exists it is authoritative.
-- 9 of 26 current closes are event-linked; older closes predate event capture
-- and keep using the fuzzy chain unchanged.

CREATE OR REPLACE VIEW public.lib_close_resolved AS  WITH closed AS (
         SELECT c.id AS closer_call_id,
            c.prospect_name,
            strip_call_suffix(c.prospect_name::text) AS clean_name,
            name_first_token(strip_call_suffix(c.prospect_name::text)) AS first_tok,
            name_second_token(strip_call_suffix(c.prospect_name::text)) AS second_tok,
            audience_from_prospect_name(c.prospect_name::text) AS audience_hint,
            c.revenue,
            c.cash_collected,
            c.created_at
           FROM closer_calls c
          WHERE c.outcome::text = 'closed'::text
        ), event_chain AS (
         SELECT DISTINCT ON (cd_1.closer_call_id) cd_1.closer_call_id,
            t.ad_id,
            t.utm_term AS adset_id,
            t.utm_campaign
           FROM closed cd_1
             JOIN closer_calls cc ON cc.id = cd_1.closer_call_id AND cc.ghl_event_id IS NOT NULL
             JOIN ghl_appointments ap ON ap.ghl_event_id = cc.ghl_event_id
             JOIN typeform_responses t ON (ap.contact_email IS NOT NULL AND lower(t.email) = lower(ap.contact_email)) OR (ap.contact_phone IS NOT NULL AND regexp_replace(COALESCE(t.phone, ''::text), 'D'::text, ''::text, 'g'::text) = regexp_replace(ap.contact_phone, 'D'::text, ''::text, 'g'::text) AND length(regexp_replace(ap.contact_phone, 'D'::text, ''::text, 'g'::text)) >= 7)
          WHERE t.ad_id IS NOT NULL OR t.utm_campaign IS NOT NULL
          ORDER BY cd_1.closer_call_id, t.submitted_at DESC NULLS LAST
        ), appt_chain AS (
         SELECT DISTINCT ON (cd_1.closer_call_id) cd_1.closer_call_id,
            t.ad_id,
            t.utm_term AS adset_id,
            t.utm_campaign
           FROM closed cd_1
             JOIN ghl_appointments ap ON ap.appointment_date >= (cd_1.created_at::date - '7 days'::interval) AND ap.appointment_date <= (cd_1.created_at::date + '2 days'::interval) AND lower(ap.contact_name) ~~* (cd_1.first_tok || '%'::text) AND ap.contact_email IS NOT NULL
             JOIN typeform_responses t ON lower(t.email) = lower(ap.contact_email)
          WHERE t.ad_id IS NOT NULL OR t.utm_campaign IS NOT NULL
          ORDER BY cd_1.closer_call_id, t.submitted_at DESC NULLS LAST
        ), tf_candidates AS (
         SELECT cd_1.closer_call_id,
            cd_1.audience_hint,
            t.ad_id,
            t.utm_term AS adset_id,
            t.utm_campaign,
            t.submitted_at,
            t.form_name,
                CASE
                    WHEN cd_1.second_tok <> ''::text AND lower(COALESCE(t.last_name, ''::text)) ~~* (('%'::text || cd_1.second_tok) || '%'::text) THEN 1
                    WHEN cd_1.second_tok <> ''::text AND lower(split_part(t.first_name, ' '::text, 2)) ~~* (('%'::text || cd_1.second_tok) || '%'::text) THEN 1
                    WHEN form_name_matches_audience(t.form_name, cd_1.audience_hint) THEN 2
                    WHEN cd_1.second_tok = ''::text THEN 3
                    ELSE 4
                END AS score
           FROM closed cd_1
             JOIN typeform_responses t ON lower(split_part(t.first_name, ' '::text, 1)) = cd_1.first_tok AND t.submitted_at::date <= cd_1.created_at::date AND t.submitted_at::date >= (cd_1.created_at::date - '60 days'::interval)
          WHERE (t.ad_id IS NOT NULL OR t.utm_campaign IS NOT NULL OR t.utm_term IS NOT NULL) AND NOT (EXISTS ( SELECT 1
                   FROM appt_chain a
                  WHERE a.closer_call_id = cd_1.closer_call_id))
        ), tf_weak_stats AS (
         SELECT tf_candidates.closer_call_id,
            count(*) AS weak_count,
            count(DISTINCT tf_candidates.form_name) AS weak_form_count
           FROM tf_candidates
          WHERE tf_candidates.score = 3
          GROUP BY tf_candidates.closer_call_id
        ), tf_ranked AS (
         SELECT c.closer_call_id,
            c.audience_hint,
            c.ad_id,
            c.adset_id,
            c.utm_campaign,
            c.submitted_at,
            c.form_name,
            c.score,
            COALESCE(s.weak_count, 0::bigint) AS weak_count,
            COALESCE(s.weak_form_count, 0::bigint) AS weak_form_count,
            row_number() OVER (PARTITION BY c.closer_call_id ORDER BY c.score, c.submitted_at DESC) AS rn
           FROM tf_candidates c
             LEFT JOIN tf_weak_stats s ON s.closer_call_id = c.closer_call_id
        ), typeform_match AS (
         SELECT tf_ranked.closer_call_id,
            tf_ranked.ad_id,
            tf_ranked.adset_id,
            tf_ranked.utm_campaign
           FROM tf_ranked
          WHERE tf_ranked.rn = 1 AND ((tf_ranked.score = ANY (ARRAY[1, 2])) OR tf_ranked.score = 3 AND tf_ranked.weak_count = 1 OR tf_ranked.score = 3 AND tf_ranked.weak_count > 1 AND tf_ranked.weak_form_count = 1)
        ), ghl_candidates AS (
         SELECT cd_1.closer_call_id,
            cd_1.audience_hint,
            g.email,
            g.phone,
            g.last_ad_id,
            g.first_ad_id,
            g.last_adset_id AS adset_id,
            COALESCE(g.last_utm_campaign, g.first_utm_campaign, g.last_form_name, g.first_form_name) AS ghl_utm_campaign,
            g.date_added,
            g.source,
                CASE
                    WHEN cd_1.second_tok <> ''::text AND lower(COALESCE(g.last_name, g.full_name, ''::text)) ~~* (('%'::text || cd_1.second_tok) || '%'::text) THEN 1
                    WHEN cd_1.second_tok = ''::text AND cd_1.audience_hint IS NOT NULL AND contact_source_matches_audience(g.source, cd_1.audience_hint) THEN 2
                    WHEN cd_1.second_tok = ''::text THEN 3
                    ELSE 4
                END AS score
           FROM closed cd_1
             JOIN ghl_contacts g ON name_first_token(g.first_name) = cd_1.first_tok
          WHERE NOT (EXISTS ( SELECT 1
                   FROM appt_chain a
                  WHERE a.closer_call_id = cd_1.closer_call_id)) AND NOT (EXISTS ( SELECT 1
                   FROM typeform_match m
                  WHERE m.closer_call_id = cd_1.closer_call_id))
        ), ghl_ranked AS (
         SELECT ghl_candidates.closer_call_id,
            ghl_candidates.audience_hint,
            ghl_candidates.email,
            ghl_candidates.phone,
            ghl_candidates.last_ad_id,
            ghl_candidates.first_ad_id,
            ghl_candidates.adset_id,
            ghl_candidates.ghl_utm_campaign,
            ghl_candidates.date_added,
            ghl_candidates.source,
            ghl_candidates.score,
            sum(
                CASE
                    WHEN ghl_candidates.score = 3 THEN 1
                    ELSE 0
                END) OVER (PARTITION BY ghl_candidates.closer_call_id) AS weak_count,
            row_number() OVER (PARTITION BY ghl_candidates.closer_call_id ORDER BY ghl_candidates.score, ghl_candidates.date_added DESC NULLS LAST) AS rn
           FROM ghl_candidates
        ), ghl_match AS (
         SELECT ghl_ranked.closer_call_id,
            COALESCE(ghl_ranked.last_ad_id, ghl_ranked.first_ad_id, ( SELECT t.ad_id
                   FROM typeform_responses t
                  WHERE t.ad_id IS NOT NULL AND (t.email IS NOT NULL AND ghl_ranked.email IS NOT NULL AND lower(t.email) = lower(ghl_ranked.email) OR t.phone IS NOT NULL AND ghl_ranked.phone IS NOT NULL AND t.phone = ghl_ranked.phone)
                  ORDER BY t.submitted_at DESC NULLS LAST, t.response_id DESC
                 LIMIT 1)) AS ad_id,
            ghl_ranked.adset_id,
            ghl_ranked.ghl_utm_campaign AS utm_campaign
           FROM ghl_ranked
          WHERE ghl_ranked.rn = 1 AND ((ghl_ranked.score = ANY (ARRAY[1, 2])) OR ghl_ranked.score = 3 AND ghl_ranked.weak_count = 1)
        ), hy_candidates AS (
         SELECT cd_1.closer_call_id,
            cd_1.audience_hint,
            h.meta_ad_id AS ad_id,
            h.campaign_name,
            h.event_date,
                CASE
                    WHEN cd_1.second_tok <> ''::text AND lower(COALESCE(h.last_name, ''::character varying)::text) ~~* (cd_1.second_tok || '%'::text) THEN 1
                    WHEN cd_1.second_tok = ''::text AND cd_1.audience_hint IS NOT NULL AND contact_source_matches_audience(h.campaign_name::text, cd_1.audience_hint) THEN 2
                    WHEN cd_1.second_tok = ''::text THEN 3
                    ELSE 4
                END AS score
           FROM closed cd_1
             JOIN hyros_events h ON name_first_token(h.first_name::text) = cd_1.first_tok
          WHERE h.meta_ad_id IS NOT NULL OR h.campaign_name IS NOT NULL
        ), hy_ranked AS (
         SELECT hy_candidates.closer_call_id,
            hy_candidates.audience_hint,
            hy_candidates.ad_id,
            hy_candidates.campaign_name,
            hy_candidates.event_date,
            hy_candidates.score,
            sum(
                CASE
                    WHEN hy_candidates.score = 3 THEN 1
                    ELSE 0
                END) OVER (PARTITION BY hy_candidates.closer_call_id) AS weak_count,
            row_number() OVER (PARTITION BY hy_candidates.closer_call_id ORDER BY hy_candidates.score, hy_candidates.event_date DESC) AS rn
           FROM hy_candidates
        ), hyros_match AS (
         SELECT hy_ranked.closer_call_id,
            hy_ranked.ad_id,
            hy_ranked.campaign_name
           FROM hy_ranked
          WHERE hy_ranked.rn = 1 AND ((hy_ranked.score = ANY (ARRAY[1, 2])) OR hy_ranked.score = 3 AND hy_ranked.weak_count = 1)
        )
 SELECT cd.closer_call_id,
    cd.prospect_name,
    cd.clean_name,
    cd.revenue,
    cd.cash_collected,
    cd.created_at,
    COALESCE(ov.ad_id, ec.ad_id, ac.ad_id, tm.ad_id, gm.ad_id, hyros_ad.ad_id, ghl_ad.ad_id) AS resolved_ad_id,
    COALESCE(ov.adset_id, ec.adset_id, ac.adset_id, tm.adset_id, gm.adset_id, hyros_ad.adset_id, ghl_ad.adset_id) AS resolved_adset_id,
    COALESCE(ov.utm_campaign, ec.utm_campaign, ac.utm_campaign, tm.utm_campaign, ghl_ad.campaign_name, hyros_ad.campaign_name, gm.utm_campaign, hm.campaign_name::text) AS resolved_campaign,
        CASE
            WHEN ov.closer_call_id IS NOT NULL THEN 'manual'::text
            WHEN ec.closer_call_id IS NOT NULL THEN 'event'::text
            WHEN ac.closer_call_id IS NOT NULL THEN 'appointment'::text
            WHEN tm.closer_call_id IS NOT NULL THEN 'typeform'::text
            WHEN gm.closer_call_id IS NOT NULL THEN 'ghl'::text
            WHEN hm.closer_call_id IS NOT NULL THEN 'hyros'::text
            ELSE 'orphan'::text
        END AS attribution_source
   FROM closed cd
     LEFT JOIN close_attribution_overrides ov ON ov.closer_call_id = cd.closer_call_id
     LEFT JOIN event_chain ec ON ec.closer_call_id = cd.closer_call_id
     LEFT JOIN appt_chain ac ON ac.closer_call_id = cd.closer_call_id
     LEFT JOIN typeform_match tm ON tm.closer_call_id = cd.closer_call_id
     LEFT JOIN ghl_match gm ON gm.closer_call_id = cd.closer_call_id
     LEFT JOIN hyros_match hm ON hm.closer_call_id = cd.closer_call_id
     LEFT JOIN LATERAL ( SELECT a.ad_id,
            a.adset_id,
            a.campaign_name
           FROM ads a
          WHERE a.ad_id = hm.ad_id
         LIMIT 1) hyros_ad ON true
     LEFT JOIN LATERAL ( SELECT a.ad_id,
            a.adset_id,
            a.campaign_name
           FROM ads a
          WHERE a.ad_id = gm.ad_id
         LIMIT 1) ghl_ad ON true;;

NOTIFY pgrst, 'reload schema';
