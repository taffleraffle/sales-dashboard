-- 187: a lead is a form fill we can contact; the AU lead-form campaigns are Australian (Ben, 14 Sep 2026)
--
-- 1. Leads. Every funnel's Typeform sends anyone under the revenue floor to a
--    DQ page BEFORE asking for a name, email or phone. Those responses land in
--    typeform_responses with nothing but the qualifier answers, and the leads
--    count has been including them since June: this week 100 of the 143
--    "leads" had no way to be contacted (YouTube 55 of 74, Australia 44 of
--    66). Cost per lead, lead-to-booked and the conversion rate were all
--    computed on that inflated count. A lead now needs an email or a phone.
--    Same window, before -> after: US 77 -> 21 Typeform leads, AU 66 -> 22
--    (+10 Facebook lead-form leads, unchanged). Every page reading
--    lib_marketing_by_audience_daily(_mv) follows.
--
-- 2. Tier. The AU and YouTube forms use '$0-$50k/m' as the DQ bucket; it was
--    not in the sync's unqualified set, so the fallback marked it qualified.
--    Backfilled here; sync-typeform carries the same rule from this commit.
--
-- 3. Campaign audience. 'OPT | GMB - BROAD - LEAD FORM - 2026-09' (and V2)
--    are the Australian Facebook lead-form campaigns: spend starts 2 Sep, the
--    'fb lead (aus)' contacts start 2 Sep, the GHL form is 'FB - Aus Leads',
--    and no US lead-form contact has arrived since August. Their names carry
--    no AU keyword, so lib_ad_audience read them as Unknown (= US on the
--    region switch) and AU ad spend was short by NZ$1,764 this week.
--
-- Only the leads_typeform WHERE clause changes in the view; the rest is the
-- current definition verbatim.
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
            AND (COALESCE(tr.email, ''::text) <> ''::text OR COALESCE(tr.phone, ''::text) <> ''::text)
          GROUP BY ((tr.submitted_at AT TIME ZONE 'America/New_York'::text)::date), (COALESCE(
                CASE
                    WHEN regexp_replace(COALESCE(tr.phone, ''::text), '\D'::text, ''::text, 'g'::text) ~ '^61'::text THEN 'Australia'::text
                    ELSE NULL::text
                END, audience_from_campaign_name(tr.form_name), aa.audience, 'Unknown'::text))
        ), leads_ghl_au AS (
         SELECT (c_1.date_added AT TIME ZONE 'America/New_York'::text)::date AS date,
            'Australia'::text AS audience,
            count(*) AS leads,
            count(*) AS qualified_leads
           FROM ghl_contacts c_1
          WHERE c_1.tags::text ~~* '%fb lead (aus)%'::text AND c_1.date_added IS NOT NULL AND NOT (c_1.email IS NOT NULL AND (EXISTS ( SELECT 1
                   FROM typeform_responses tr
                  WHERE lower(tr.email) = lower(c_1.email))))
          GROUP BY ((c_1.date_added AT TIME ZONE 'America/New_York'::text)::date)
        ), leads_d AS (
         SELECT u.date,
            u.audience,
            sum(u.leads)::bigint AS leads,
            sum(u.qualified_leads)::bigint AS qualified_leads
           FROM ( SELECT leads_typeform.date,
                    leads_typeform.audience,
                    leads_typeform.leads,
                    leads_typeform.qualified_leads
                   FROM leads_typeform
                UNION ALL
                 SELECT leads_ghl_au.date,
                    leads_ghl_au.audience,
                    leads_ghl_au.leads,
                    leads_ghl_au.qualified_leads
                   FROM leads_ghl_au) u
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
          WHERE cca.call_type::text = 'new_call'::text AND (cca.outcome::text = ANY (ARRAY['closed'::text, 'not_closed'::text])) AND NOT (EXISTS ( SELECT 1
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
          WHERE cca.call_type::text = 'new_call'::text AND NOT (EXISTS ( SELECT 1
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
          WHERE cca.call_type::text = 'ascension'::text AND NOT (EXISTS ( SELECT 1
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
          WHERE NOT (EXISTS ( SELECT 1
                   FROM closer_call_excluded e
                  WHERE e.closer_call_id = cca.closer_call_id))
          GROUP BY cca.report_date, cca.audience
        ), resolver_floor AS (
         SELECT COALESCE(min((lib_close_audience.created_at AT TIME ZONE 'America/New_York'::text)::date), '2099-01-01'::date) AS d
           FROM lib_close_audience
        ), close_d AS (
         SELECT COALESCE(( SELECT r.report_date
                   FROM closer_calls cc
                     JOIN closer_eod_reports r ON r.id = cc.eod_report_id
                  WHERE cc.id = ca.closer_call_id), (ca.created_at AT TIME ZONE 'America/New_York'::text)::date) AS date,
            ca.audience,
            count(*) AS closes,
            sum(ca.revenue) AS revenue,
            sum(ca.cash_collected) AS cash
           FROM lib_close_audience ca
          WHERE ca.audience <> 'Referral'::text
          GROUP BY (COALESCE(( SELECT r.report_date
                   FROM closer_calls cc
                     JOIN closer_eod_reports r ON r.id = cc.eod_report_id
                  WHERE cc.id = ca.closer_call_id), (ca.created_at AT TIME ZONE 'America/New_York'::text)::date)), ca.audience
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

UPDATE public.typeform_responses
   SET tier = 'unqualified'
 WHERE revenue_tier = '$0-$50k/m' AND tier IS DISTINCT FROM 'unqualified';

INSERT INTO public.campaign_audience_overrides (campaign_id, campaign_name, audience_slug, notes)
VALUES
  ('120252064008540530', 'OPT | GMB - BROAD - LEAD FORM - 2026-09',    'australia', 'AU Facebook lead-form campaign (fb lead (aus) contacts); migration 187, 14 Sep 2026'),
  ('120252085152490530', 'OPT | GMB - BROAD - LEAD FORM - 2026-09 V2', 'australia', 'AU Facebook lead-form campaign (fb lead (aus) contacts); migration 187, 14 Sep 2026')
ON CONFLICT (campaign_id) DO UPDATE SET audience_slug = EXCLUDED.audience_slug, campaign_name = EXCLUDED.campaign_name, notes = EXCLUDED.notes;

REFRESH MATERIALIZED VIEW public.lib_marketing_by_audience_daily_mv;
