-- 147: fix the close-resolver's uncorrelated typeform fallback + make
-- audience name-match laterals deterministic.
--
-- BUG 1 (critical): lib_close_resolved's ghl_match fallback read
--   WHERE ... lower(t.email) = lower(t.email) OR t.phone = t.phone
-- (introduced migration 125, carried into 128) — a tautology: SQL scoping
-- bound the unqualified email/phone to typeform_responses itself, so any
-- GHL-matched close without last/first_ad_id inherited the ad_id of the
-- GLOBALLY MOST RECENT typeform response, from any human. Attribution then
-- changed every time anyone submitted a typeform — the "numbers change all
-- the time" root cause. Now correlated to the matched GHL contact's own
-- email/phone, with a response_id tiebreak for equal timestamps.
--
-- BUG 2: the booking-name-match laterals in lib_close_audience and
-- lib_closer_call_audience used LIMIT 1 with no ORDER BY — among several
-- name-matching bookings the pick was query-plan-dependent and could flip
-- between page loads. Both now order by booked_at DESC, id.
-- lib_close_audience also gains the NOT is_spam guard and the ' - ' name
-- branch so its booking fallback finally matches its migration-145 twin.

create or replace view public.lib_close_resolved as
 WITH closed AS (
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
    COALESCE(ov.ad_id, ac.ad_id, tm.ad_id, gm.ad_id, hyros_ad.ad_id, ghl_ad.ad_id) AS resolved_ad_id,
    COALESCE(ov.adset_id, ac.adset_id, tm.adset_id, gm.adset_id, hyros_ad.adset_id, ghl_ad.adset_id) AS resolved_adset_id,
    COALESCE(ov.utm_campaign, ac.utm_campaign, tm.utm_campaign, ghl_ad.campaign_name, hyros_ad.campaign_name, gm.utm_campaign, hm.campaign_name::text) AS resolved_campaign,
        CASE
            WHEN ov.closer_call_id IS NOT NULL THEN 'manual'::text
            WHEN ac.closer_call_id IS NOT NULL THEN 'appointment'::text
            WHEN tm.closer_call_id IS NOT NULL THEN 'typeform'::text
            WHEN gm.closer_call_id IS NOT NULL THEN 'ghl'::text
            WHEN hm.closer_call_id IS NOT NULL THEN 'hyros'::text
            ELSE 'orphan'::text
        END AS attribution_source
   FROM closed cd
     LEFT JOIN close_attribution_overrides ov ON ov.closer_call_id = cd.closer_call_id
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
         LIMIT 1) ghl_ad ON true;

-- ── BUG 2: deterministic, consistent booking-name fallbacks ──────────────

create or replace view public.lib_close_audience as
SELECT cr.closer_call_id,
    cr.prospect_name,
    cr.clean_name,
    cr.revenue,
    cr.cash_collected,
    cr.created_at,
    cr.resolved_ad_id,
    cr.resolved_adset_id,
    cr.resolved_campaign,
    cr.attribution_source,
        CASE
            WHEN cr.resolved_campaign = 'REFERRAL'::text THEN 'Referral'::text
            ELSE COALESCE(aa.audience, NULLIF(audience_from_campaign_name(cr.resolved_campaign), 'Unknown'::text), bk.aud, 'Unknown'::text)
        END AS audience
   FROM lib_close_resolved cr
     LEFT JOIN lib_ad_audience aa ON aa.ad_id = cr.resolved_ad_id
     LEFT JOIN LATERAL ( SELECT bk_1.audience AS aud
           FROM lib_strategy_booking_resolved bk_1
          WHERE bk_1.audience <> 'Unknown'::text AND NOT bk_1.is_spam
            AND (lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' and '::text, 1))) = lower(TRIM(BOTH FROM split_part(cr.prospect_name::text, ' and '::text, 1)))
              OR lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' - '::text, 1))) = lower(TRIM(BOTH FROM split_part(cr.prospect_name::text, ' - '::text, 1))))
          ORDER BY bk_1.booked_at DESC NULLS LAST, bk_1.id
         LIMIT 1) bk ON true;

create or replace view public.lib_closer_call_audience as
SELECT cc.id AS closer_call_id,
    cc.prospect_name,
    TRIM(BOTH FROM split_part(cc.prospect_name::text, ' and '::text, 1)) AS clean_first_part,
    TRIM(BOTH FROM split_part(cc.prospect_name::text, ' - '::text, 1)) AS strip_suffix,
    cc.call_type,
    cc.outcome,
    cc.revenue,
    cc.cash_collected,
    cc.offered_finance,
    cc.eod_report_id,
    cc.created_at,
    cer.report_date,
    cer.is_confirmed,
    COALESCE(cl.aud, bk.aud, 'Unknown'::text) AS audience
   FROM closer_calls cc
     LEFT JOIN closer_eod_reports cer ON cer.id = cc.eod_report_id
     LEFT JOIN LATERAL ( SELECT ca.audience AS aud
           FROM lib_close_audience ca
          WHERE ca.closer_call_id = cc.id AND ca.audience <> 'Unknown'::text
         LIMIT 1) cl ON true
     LEFT JOIN LATERAL ( SELECT bk_1.audience AS aud
           FROM lib_strategy_booking_resolved bk_1
          WHERE bk_1.audience <> 'Unknown'::text AND NOT bk_1.is_spam
            AND (lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' and '::text, 1))) = lower(TRIM(BOTH FROM split_part(cc.prospect_name::text, ' and '::text, 1)))
              OR lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' - '::text, 1))) = lower(TRIM(BOTH FROM split_part(cc.prospect_name::text, ' - '::text, 1))))
          ORDER BY bk_1.booked_at DESC NULLS LAST, bk_1.id
         LIMIT 1) bk ON true;

-- Propagate to the tiles immediately.
select public.refresh_marketing_trend_mv();
