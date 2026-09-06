-- 176: Australian Facebook lead-form leads count as leads (Ben, 6 Sep 2026)
-- AU leads come in as Facebook Lead Ads and land in GoHighLevel tagged "fb lead (aus)";
-- they never touch Typeform, so the daily marketing view (and every CPL on the
-- dashboard) missed them. They now join the leads bucket as audience Australia by
-- the New York date they were added. Contacts with a Typeform response are skipped.
CREATE OR REPLACE VIEW public.lib_marketing_by_audience_daily AS
 WITH ad_aud AS MATERIALIZED (
         SELECT lib_ad_audience.ad_id,
            lib_ad_audience.audience
           FROM lib_ad_audience
        ), spend_d AS (
         SELECT s_1.date,
            aa.audience,
            sum(s_1.spend) AS adspend,
            sum(s_1.impressions) AS impressions,
            sum(s_1.clicks) AS clicks
           FROM ad_daily_stats s_1
             JOIN ad_aud aa ON aa.ad_id = s_1.ad_id
          GROUP BY s_1.date, aa.audience
        ), leads_typeform AS (
         SELECT (tr.submitted_at AT TIME ZONE 'America/New_York'::text)::date AS date,
            COALESCE(
                CASE
                    WHEN regexp_replace(COALESCE(tr.phone, ''::text), '\D'::text, ''::text, 'g'::text) ~ '^61'::text THEN 'Australia'::text
                    ELSE NULL::text
                END, audience_from_campaign_name(tr.form_name), aa.audience, 'Unknown'::text) AS audience,
            count(*) AS leads,
            count(*) FILTER (WHERE tr.qualified) AS qualified_leads
           FROM typeform_responses tr
             LEFT JOIN ad_aud aa ON aa.ad_id = tr.ad_id
          WHERE NOT (EXISTS ( SELECT 1
                   FROM lead_excluded le
                  WHERE le.response_id = tr.response_id))
          GROUP BY ((tr.submitted_at AT TIME ZONE 'America/New_York'::text)::date), (COALESCE(
                CASE
                    WHEN regexp_replace(COALESCE(tr.phone, ''::text), '\D'::text, ''::text, 'g'::text) ~ '^61'::text THEN 'Australia'::text
                    ELSE NULL::text
                END, audience_from_campaign_name(tr.form_name), aa.audience, 'Unknown'::text))
        ), leads_ghl_au AS (
         SELECT (c.date_added AT TIME ZONE 'America/New_York'::text)::date AS date,
            'Australia'::text AS audience,
            count(*) AS leads,
            count(*) AS qualified_leads
           FROM ghl_contacts c
          WHERE c.tags::text ~~* '%fb lead (aus)%'::text
            AND c.date_added IS NOT NULL
            AND NOT (c.email IS NOT NULL AND EXISTS ( SELECT 1 FROM typeform_responses tr WHERE lower(tr.email) = lower(c.email)))
          GROUP BY ((c.date_added AT TIME ZONE 'America/New_York'::text)::date)
        ), leads_d AS (
         SELECT u.date, u.audience, sum(u.leads)::bigint AS leads, sum(u.qualified_leads)::bigint AS qualified_leads
           FROM ( SELECT leads_typeform.date, leads_typeform.audience, leads_typeform.leads, leads_typeform.qualified_leads FROM leads_typeform
                  UNION ALL
                  SELECT leads_ghl_au.date, leads_ghl_au.audience, leads_ghl_au.leads, leads_ghl_au.qualified_leads FROM leads_ghl_au) u
          GROUP BY u.date, u.audience
        ), qual_bookings_d AS (
         SELECT b.booked_at AS date,
            b.audience,
            count(*) AS qualified_bookings
           FROM lib_strategy_booking_resolved b
          WHERE NOT b.is_dq AND NOT b.is_spam AND NOT (EXISTS ( SELECT 1
                   FROM booking_excluded be
                  WHERE be.booking_id = b.id))
          GROUP BY b.booked_at, b.audience
        ), live_d AS (
         SELECT cca.report_date AS date,
            cca.audience,
            count(*) AS live_calls
           FROM lib_closer_call_audience cca
          WHERE cca.is_confirmed AND cca.call_type::text = 'new_call'::text AND (cca.outcome::text = ANY (ARRAY['closed'::text, 'not_closed'::text])) AND NOT (EXISTS ( SELECT 1
                   FROM closer_call_excluded e
                  WHERE e.closer_call_id = cca.closer_call_id))
          GROUP BY cca.report_date, cca.audience
        ), showrate_d AS (
         SELECT cca.report_date AS date,
            cca.audience,
            count(*) FILTER (WHERE cca.outcome::text = 'no_show'::text) AS no_shows,
            count(*) FILTER (WHERE cca.outcome::text = 'rescheduled'::text) AS reschedules,
            count(*) FILTER (WHERE cca.outcome::text = 'canceled'::text) AS cancels
           FROM lib_closer_call_audience cca
          WHERE cca.is_confirmed AND cca.call_type::text = 'new_call'::text AND NOT (EXISTS ( SELECT 1
                   FROM closer_call_excluded e
                  WHERE e.closer_call_id = cca.closer_call_id))
          GROUP BY cca.report_date, cca.audience
        ), ascensions_d AS (
         SELECT cca.report_date AS date,
            cca.audience,
            count(*) AS ascensions,
            count(*) FILTER (WHERE cca.outcome::text = 'ascended'::text) AS ascensions_closed,
            sum(
                CASE
                    WHEN cca.outcome::text = 'ascended'::text THEN cca.cash_collected
                    ELSE 0::numeric
                END) AS ascend_cash,
            sum(
                CASE
                    WHEN cca.outcome::text = 'ascended'::text THEN cca.revenue
                    ELSE 0::numeric
                END) AS ascend_revenue
           FROM lib_closer_call_audience cca
          WHERE cca.is_confirmed AND cca.call_type::text = 'ascension'::text AND NOT (EXISTS ( SELECT 1
                   FROM closer_call_excluded e
                  WHERE e.closer_call_id = cca.closer_call_id))
          GROUP BY cca.report_date, cca.audience
        ), closer_d AS (
         SELECT cca.report_date AS date,
            cca.audience,
            count(*) FILTER (WHERE cca.outcome::text = ANY (ARRAY['closed'::text, 'not_closed'::text])) AS net_live_calls,
            count(*) FILTER (WHERE cca.call_type::text = 'follow_up'::text AND (cca.outcome::text = ANY (ARRAY['closed'::text, 'not_closed'::text]))) AS fu_lives,
            count(*) FILTER (WHERE cca.offered_finance) AS finance_offers
           FROM lib_closer_call_audience cca
          WHERE cca.is_confirmed AND NOT (EXISTS ( SELECT 1
                   FROM closer_call_excluded e
                  WHERE e.closer_call_id = cca.closer_call_id))
          GROUP BY cca.report_date, cca.audience
        ), resolver_floor AS (
         SELECT COALESCE(min((lib_close_audience.created_at AT TIME ZONE 'America/New_York'::text)::date), '2099-01-01'::date) AS d
           FROM lib_close_audience
        ), close_d AS (
         SELECT (ca.created_at AT TIME ZONE 'America/New_York'::text)::date AS date,
            ca.audience,
            count(*) AS closes,
            sum(ca.revenue) AS revenue,
            sum(ca.cash_collected) AS cash
           FROM lib_close_audience ca
          WHERE ca.audience <> 'Referral'::text
          GROUP BY ((ca.created_at AT TIME ZONE 'America/New_York'::text)::date), ca.audience
        UNION ALL
         SELECT mt.date,
            'Unknown'::text AS audience,
            mt.closes::bigint AS closes,
            mt.trial_revenue::numeric AS revenue,
            mt.trial_cash::numeric AS cash
           FROM marketing_tracker mt,
            resolver_floor f
          WHERE mt.date < f.d AND (COALESCE(mt.closes, 0) > 0 OR COALESCE(mt.trial_cash, 0::numeric) > 0::numeric)
        ), close_d_agg AS (
         SELECT close_d.date,
            close_d.audience,
            sum(close_d.closes)::bigint AS closes,
            sum(close_d.revenue) AS revenue,
            sum(close_d.cash) AS cash
           FROM close_d
          GROUP BY close_d.date, close_d.audience
        ), all_keys AS (
         SELECT spend_d.date,
            spend_d.audience
           FROM spend_d
        UNION
         SELECT leads_d.date,
            leads_d.audience
           FROM leads_d
        UNION
         SELECT qual_bookings_d.date,
            qual_bookings_d.audience
           FROM qual_bookings_d
        UNION
         SELECT live_d.date,
            live_d.audience
           FROM live_d
        UNION
         SELECT showrate_d.date,
            showrate_d.audience
           FROM showrate_d
        UNION
         SELECT ascensions_d.date,
            ascensions_d.audience
           FROM ascensions_d
        UNION
         SELECT closer_d.date,
            closer_d.audience
           FROM closer_d
        UNION
         SELECT close_d_agg.date,
            close_d_agg.audience
           FROM close_d_agg
        )
 SELECT k.date,
    k.audience,
    COALESCE(s.adspend, 0::numeric) AS adspend,
    COALESCE(s.impressions, 0::bigint) AS impressions,
    COALESCE(s.clicks, 0::bigint) AS clicks,
    COALESCE(l.leads, 0::bigint) AS leads,
    COALESCE(l.qualified_leads, 0::bigint) AS qualified_leads,
    COALESCE(q.qualified_bookings, 0::bigint) AS qualified_bookings,
    COALESCE(lv.live_calls, 0::bigint) AS live_calls,
    COALESCE(c.closes, 0::bigint) AS closes,
    COALESCE(c.revenue, 0::numeric) AS trial_revenue,
    COALESCE(c.cash, 0::numeric) AS trial_cash,
    COALESCE(asc1.ascensions, 0::bigint) AS ascensions,
    COALESCE(asc1.ascensions_closed, 0::bigint) AS ascensions_closed,
    COALESCE(asc1.ascend_cash, 0::numeric) AS ascend_cash,
    COALESCE(asc1.ascend_revenue, 0::numeric) AS ascend_revenue,
    COALESCE(sr.no_shows, 0::bigint) AS no_shows,
    COALESCE(sr.reschedules, 0::bigint) AS reschedules,
    COALESCE(sr.cancels, 0::bigint) AS cancels,
    COALESCE(cd.net_live_calls, 0::bigint) AS net_live_calls,
    COALESCE(cd.fu_lives, 0::bigint) AS fu_lives,
    COALESCE(cd.finance_offers, 0::bigint) AS finance_offers
   FROM all_keys k
     LEFT JOIN spend_d s ON s.date = k.date AND s.audience = k.audience
     LEFT JOIN leads_d l ON l.date = k.date AND l.audience = k.audience
     LEFT JOIN qual_bookings_d q ON q.date = k.date AND q.audience = k.audience
     LEFT JOIN live_d lv ON lv.date = k.date AND lv.audience = k.audience
     LEFT JOIN showrate_d sr ON sr.date = k.date AND sr.audience = k.audience
     LEFT JOIN ascensions_d asc1 ON asc1.date = k.date AND asc1.audience = k.audience
     LEFT JOIN closer_d cd ON cd.date = k.date AND cd.audience = k.audience
     LEFT JOIN close_d_agg c ON c.date = k.date AND c.audience = k.audience
  ORDER BY k.date DESC, k.audience;
