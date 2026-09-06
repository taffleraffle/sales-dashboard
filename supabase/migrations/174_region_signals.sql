-- 174: region signals for the Australia launch (Ben, 6 Sep 2026)
-- "Separate Australian leads and US leads": every resolver gains an Australian
-- phone-number signal (+61) so an AU lead, booking or call is tagged Australia
-- even when the form or campaign name gives nothing away. The Australia audience
-- also gains the keywords the AU forms and campaigns actually use. A new
-- confirmation view carries audience so the dashboard's region filter can split
-- confirmed / unconfirmed show rates too.

-- 1. Keywords the AU form ("Facebook Oz (AU)") and campaigns ("... - AU - ...", "TRADIES AU") use
UPDATE public.audience_definitions
   SET keywords = ARRAY['tradies','tradie','australia','australian','(au)',' au ','- au -','au - ','facebook oz','facebook-au','au-tradie']
 WHERE slug = 'australia';

-- 2. Leads: +61 phone => Australia (after manual and ad overrides)
CREATE OR REPLACE VIEW public.lib_typeform_audience_resolved AS
 SELECT tr.response_id,
    COALESCE(ro.audience_slug, ao.audience_slug, CASE WHEN regexp_replace(COALESCE(tr.phone, ''::text), '\D'::text, ''::text, 'g'::text) ~ '^61'::text THEN 'australia'::text ELSE NULL::text END, form_slug.slug, co.audience_slug, utm_slug.slug, ad_slug.slug) AS audience_slug,
        CASE
            WHEN ro.audience_slug IS NOT NULL THEN 'response_override'::text
            WHEN ao.audience_slug IS NOT NULL THEN 'ad_override'::text
            WHEN regexp_replace(COALESCE(tr.phone, ''::text), '\D'::text, ''::text, 'g'::text) ~ '^61'::text THEN 'phone_au'::text
            WHEN form_slug.slug IS NOT NULL THEN 'funnel'::text
            WHEN co.audience_slug IS NOT NULL THEN 'campaign_override'::text
            WHEN utm_slug.slug IS NOT NULL THEN 'parsed'::text
            WHEN ad_slug.slug IS NOT NULL THEN 'ad_resolved'::text
            ELSE 'unknown'::text
        END AS audience_source,
    COALESCE(ro.ad_id, tr.ad_id) AS ad_id
   FROM typeform_responses tr
     LEFT JOIN typeform_response_overrides ro ON ro.response_id = tr.response_id
     LEFT JOIN ad_audience_overrides ao ON ao.ad_id = COALESCE(ro.ad_id, tr.ad_id)
     LEFT JOIN campaign_audience_overrides co ON co.campaign_id = tr.utm_campaign
     LEFT JOIN lib_ad_audience laa ON laa.ad_id = COALESCE(ro.ad_id, tr.ad_id)
     LEFT JOIN LATERAL ( SELECT d.slug
           FROM audience_definitions d
          WHERE d.is_active AND tr.form_name IS NOT NULL AND (EXISTS ( SELECT 1
                   FROM unnest(d.keywords) kw(kw)
                  WHERE tr.form_name ~~* (('%'::text || kw.kw) || '%'::text)))
          ORDER BY d.sort_order, d.slug
         LIMIT 1) form_slug ON true
     LEFT JOIN LATERAL ( SELECT d.slug
           FROM audience_definitions d
          WHERE d.is_active AND tr.utm_campaign IS NOT NULL AND (EXISTS ( SELECT 1
                   FROM unnest(d.keywords) kw(kw)
                  WHERE tr.utm_campaign ~~* (('%'::text || kw.kw) || '%'::text)))
          ORDER BY d.sort_order, d.slug
         LIMIT 1) utm_slug ON true
     LEFT JOIN LATERAL ( SELECT d.slug
           FROM audience_definitions d
          WHERE d.display_name = laa.audience
          ORDER BY d.sort_order, d.slug
         LIMIT 1) ad_slug ON true;

-- 3. Bookings: +61 contact phone => Australia (after manual and ad overrides)
CREATE OR REPLACE VIEW public.lib_strategy_booking_resolved AS
 WITH strategy_calendars AS (
         SELECT cid.cid AS id,
            a.display_name AS audience_hint,
            a.is_dq
           FROM audience_definitions a,
            LATERAL unnest(a.calendar_ids) cid(cid)
          WHERE a.is_active
        UNION ALL
         SELECT 'gohFzPCilzwBtVfaC6fu'::text AS text,
            NULL::text AS text,
            true
        UNION ALL
         SELECT 'T5Zif5GjDwulya6novU0'::text AS text,
            NULL::text AS text,
            false
        UNION ALL
         SELECT 'el8rJciCrMWpWiH1ulGc'::text AS text,
            NULL::text AS text,
            false
        UNION ALL
         SELECT 'WnXnhT0m3MNezzoFQbcG'::text AS text,
            NULL::text AS text,
            false
        ), bookings AS (
         SELECT DISTINCT ON ((COALESCE(a.ghl_contact_id, a.contact_email))) a.id,
            a.ghl_event_id,
            a.ghl_contact_id,
            a.contact_email,
            a.contact_phone,
            a.contact_name,
            TRIM(BOTH FROM split_part(a.contact_name, ' and '::text, 1)) AS prospect_name,
            a.calendar_name,
            a.utm_campaign AS booking_utm_campaign,
            (a.booked_at::timestamp with time zone AT TIME ZONE 'America/New_York'::text)::date AS booked_at,
            a.appointment_date,
            a.appointment_status,
            a.revenue_tier
           FROM ghl_appointments a
             JOIN strategy_calendars sc_1 ON sc_1.id = a.calendar_name
          WHERE a.appointment_status <> 'cancelled'::text
          ORDER BY (COALESCE(a.ghl_contact_id, a.contact_email)), a.booked_at DESC
        ), tf_by_email AS (
         SELECT DISTINCT ON ((lower(tr.email))) lower(tr.email) AS k,
            tr.ad_id,
            audience_from_campaign_name(tr.utm_campaign) AS audience_from_utm,
            tr.form_name
           FROM typeform_responses tr
          WHERE tr.email IS NOT NULL AND tr.email <> ''::text
          ORDER BY (lower(tr.email)), tr.submitted_at DESC
        ), tf_by_phone AS (
         SELECT DISTINCT ON ((regexp_replace(tr.phone, '\D'::text, ''::text, 'g'::text))) regexp_replace(tr.phone, '\D'::text, ''::text, 'g'::text) AS k,
            tr.ad_id,
            audience_from_campaign_name(tr.utm_campaign) AS audience_from_utm,
            tr.form_name
           FROM typeform_responses tr
          WHERE tr.phone IS NOT NULL AND length(regexp_replace(tr.phone, '\D'::text, ''::text, 'g'::text)) >= 7
          ORDER BY (regexp_replace(tr.phone, '\D'::text, ''::text, 'g'::text)), tr.submitted_at DESC
        ), tf_by_first AS (
         SELECT DISTINCT ON ((lower(tr.first_name))) lower(tr.first_name) AS k,
            tr.ad_id,
            audience_from_campaign_name(tr.utm_campaign) AS audience_from_utm,
            tr.form_name,
            tr.last_name
           FROM typeform_responses tr
          WHERE tr.first_name IS NOT NULL AND tr.first_name <> ''::text
          ORDER BY (lower(tr.first_name)), tr.submitted_at DESC
        ), form_audience AS (
         SELECT DISTINCT tr.form_name,
            audience_from_campaign_name(tr.form_name) AS aud
           FROM typeform_responses tr
          WHERE tr.form_name IS NOT NULL
        ), match_picked AS (
         SELECT b_1.id,
            COALESCE(tfe.ad_id, tfp.ad_id, tff.ad_id) AS tf_ad_id,
            COALESCE(tfe.audience_from_utm, tfp.audience_from_utm, tff.audience_from_utm) AS audience_from_utm,
            COALESCE(tfe.form_name, tfp.form_name, tff.form_name) AS form_name,
                CASE
                    WHEN tfe.ad_id IS NOT NULL OR tfe.audience_from_utm IS NOT NULL OR tfe.form_name IS NOT NULL THEN 'email'::text
                    WHEN tfp.ad_id IS NOT NULL OR tfp.audience_from_utm IS NOT NULL OR tfp.form_name IS NOT NULL THEN 'phone'::text
                    WHEN tff.ad_id IS NOT NULL OR tff.audience_from_utm IS NOT NULL OR tff.form_name IS NOT NULL THEN 'first_name'::text
                    ELSE NULL::text
                END AS match_method
           FROM bookings b_1
             LEFT JOIN tf_by_email tfe ON tfe.k = lower(b_1.contact_email)
             LEFT JOIN tf_by_phone tfp ON tfp.k = regexp_replace(COALESCE(b_1.contact_phone, ''::text), '\D'::text, ''::text, 'g'::text) AND length(regexp_replace(COALESCE(b_1.contact_phone, ''::text), '\D'::text, ''::text, 'g'::text)) >= 7
             LEFT JOIN tf_by_first tff ON tff.k = lower(b_1.prospect_name) AND b_1.prospect_name <> ''::text
        )
 SELECT b.id,
    b.ghl_event_id,
    b.ghl_contact_id,
    b.contact_email,
    b.contact_name,
    b.calendar_name,
    b.booked_at,
    b.appointment_date,
    b.appointment_status,
    b.revenue_tier,
    sc.is_dq,
    COALESCE(bo.audience, audience_display_name(ao.audience_slug), CASE WHEN regexp_replace(COALESCE(b.contact_phone, ''::text), '\D'::text, ''::text, 'g'::text) ~ '^61'::text THEN 'Australia'::text ELSE NULL::text END, NULLIF(fa.aud, 'Unknown'::text), NULLIF(mp.audience_from_utm, 'Unknown'::text), NULLIF(audience_from_campaign_name(b.booking_utm_campaign), 'Unknown'::text), aa.audience, sc.audience_hint, 'Unknown'::text) AS audience,
        CASE
            WHEN bo.audience IS NOT NULL THEN 'manual'::text
            WHEN audience_display_name(ao.audience_slug) IS NOT NULL THEN 'ad_override'::text
            WHEN regexp_replace(COALESCE(b.contact_phone, ''::text), '\D'::text, ''::text, 'g'::text) ~ '^61'::text THEN 'phone_au'::text
            WHEN NULLIF(fa.aud, 'Unknown'::text) IS NOT NULL THEN ('funnel('::text || mp.match_method) || ')'::text
            WHEN NULLIF(mp.audience_from_utm, 'Unknown'::text) IS NOT NULL THEN ('typeform_utm('::text || mp.match_method) || ')'::text
            WHEN NULLIF(audience_from_campaign_name(b.booking_utm_campaign), 'Unknown'::text) IS NOT NULL THEN 'booking_utm'::text
            WHEN aa.audience IS NOT NULL THEN ('typeform_ad_id('::text || mp.match_method) || ')'::text
            WHEN sc.audience_hint IS NOT NULL THEN 'calendar_hint'::text
            ELSE 'unresolved'::text
        END AS audience_source,
    mp.tf_ad_id AS resolved_ad_id,
    ad.campaign_id AS resolved_campaign_id,
    ad.adset_id AS resolved_adset_id,
    mp.match_method AS resolved_match_method,
    b.contact_name ~* 'opt digital'::text OR b.prospect_name ~ '^[0-9]+$'::text OR length(b.prospect_name) <= 2 AND (b.contact_email IS NULL OR b.contact_email = ''::text) OR (lower(b.prospect_name) = ANY (ARRAY['test'::text, 'asdf'::text, 'dsd'::text, 'abc'::text, 'qwerty'::text, 'xxx'::text, 'sdfsdf'::text, 'dsdsd'::text, 'sdf'::text])) AS is_spam
   FROM bookings b
     JOIN strategy_calendars sc ON sc.id = b.calendar_name
     LEFT JOIN match_picked mp ON mp.id = b.id
     LEFT JOIN ads ad ON ad.ad_id = mp.tf_ad_id
     LEFT JOIN lib_ad_audience aa ON aa.ad_id = mp.tf_ad_id
     LEFT JOIN form_audience fa ON fa.form_name = mp.form_name
     LEFT JOIN booking_audience_overrides bo ON bo.booking_id = b.id
     LEFT JOIN ad_audience_overrides ao ON ao.ad_id = mp.tf_ad_id;

-- 4. Daily marketing view: leads with a +61 phone bucket as Australia (2 occurrences patched)
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
        ), leads_d AS (
         SELECT (tr.submitted_at AT TIME ZONE 'America/New_York'::text)::date AS date,
            COALESCE(CASE WHEN regexp_replace(COALESCE(tr.phone, ''::text), '\D'::text, ''::text, 'g'::text) ~ '^61'::text THEN 'Australia'::text ELSE NULL::text END, audience_from_campaign_name(tr.form_name), aa.audience, 'Unknown'::text) AS audience,
            count(*) AS leads,
            count(*) FILTER (WHERE tr.qualified) AS qualified_leads
           FROM typeform_responses tr
             LEFT JOIN ad_aud aa ON aa.ad_id = tr.ad_id
          WHERE NOT (EXISTS ( SELECT 1
                   FROM lead_excluded le
                  WHERE le.response_id = tr.response_id))
          GROUP BY ((tr.submitted_at AT TIME ZONE 'America/New_York'::text)::date), (COALESCE(CASE WHEN regexp_replace(COALESCE(tr.phone, ''::text), '\D'::text, ''::text, 'g'::text) ~ '^61'::text THEN 'Australia'::text ELSE NULL::text END, audience_from_campaign_name(tr.form_name), aa.audience, 'Unknown'::text))
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

-- 5. Confirmation marks with audience, for the region filter
CREATE OR REPLACE VIEW public.lib_call_confirmation_by_closer_audience AS
 SELECT r.closer_id,
    r.report_date,
    COALESCE(cca.audience, 'Unknown'::text) AS audience,
    count(*) FILTER (WHERE cs.confirmation = 'confirmed'::text) AS confirmed_calls,
    count(*) FILTER (WHERE cs.confirmation = 'confirmed'::text AND ((cc.outcome::text = ANY (ARRAY['closed'::character varying, 'not_closed'::character varying]::text[])) OR cc.showed = true)) AS confirmed_showed,
    count(*) FILTER (WHERE cs.confirmation = 'confirmed'::text AND cc.outcome::text = 'no_show'::text) AS confirmed_noshow,
    count(*) FILTER (WHERE cs.confirmation = 'unconfirmed'::text) AS unconfirmed_calls,
    count(*) FILTER (WHERE cs.confirmation = 'unconfirmed'::text AND ((cc.outcome::text = ANY (ARRAY['closed'::character varying, 'not_closed'::character varying]::text[])) OR cc.showed = true)) AS unconfirmed_showed,
    count(*) FILTER (WHERE cs.confirmation = 'unconfirmed'::text AND cc.outcome::text = 'no_show'::text) AS unconfirmed_noshow
   FROM closer_calls cc
     JOIN closer_eod_reports r ON r.id = cc.eod_report_id
     JOIN ghl_appointments a ON a.ghl_event_id = cc.ghl_event_id
     JOIN booking_call_status cs ON cs.ghl_contact_id = a.ghl_contact_id
     LEFT JOIN lib_closer_call_audience cca ON cca.closer_call_id = cc.id
  WHERE cc.ghl_event_id IS NOT NULL AND cc.ghl_event_id <> ''::text
  GROUP BY r.closer_id, r.report_date, COALESCE(cca.audience, 'Unknown'::text);

GRANT SELECT ON public.lib_call_confirmation_by_closer_audience TO anon, authenticated, service_role;
