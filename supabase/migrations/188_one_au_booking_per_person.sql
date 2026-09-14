-- 188: one Australian booking per person; a call on the AUS Calendly event is Australian (Ben, 15 Sep 2026)
--
-- The GHL branch of lib_strategy_booking_resolved keeps one booking per
-- contact (DISTINCT ON contact, latest). The Calendly branch added for
-- Australia in migration 175 never got that rule, so a prospect who rebooked
-- counted twice: 38 AU booking rows for 33 people in 30 days (David at
-- wilcomm twice, "TT" twice, Chad Mckelvey, Mark Stachnik, Robert). Cost per
-- booked call and show rate were computed on the inflated count, and the
-- Marketing page (which dedupes by first name) disagreed with the Overview.
-- Now: one booking per invitee email, the latest, same as GHL.
--
-- Dropping the older booking would break the exact event-id match that gives
-- a logged call its region (Robert's 7 Sep call was logged against his older
-- booking). So the call and close resolvers also check calendly_bookings
-- directly: a call logged against any AUS Calendly booking is Australian.
--
-- Simulated read-only before applying: AU bookings 30d 38 -> 33, no call or
-- close changes audience.

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
                CASE
                    WHEN tfe.k IS NOT NULL THEN tfe.ad_id
                    WHEN tfp.k IS NOT NULL THEN tfp.ad_id
                    WHEN tff.k IS NOT NULL THEN tff.ad_id
                    ELSE NULL::text
                END AS tf_ad_id,
                CASE
                    WHEN tfe.k IS NOT NULL THEN tfe.audience_from_utm
                    WHEN tfp.k IS NOT NULL THEN tfp.audience_from_utm
                    WHEN tff.k IS NOT NULL THEN tff.audience_from_utm
                    ELSE NULL::text
                END AS audience_from_utm,
                CASE
                    WHEN tfe.k IS NOT NULL THEN tfe.form_name
                    WHEN tfp.k IS NOT NULL THEN tfp.form_name
                    WHEN tff.k IS NOT NULL THEN tff.form_name
                    ELSE NULL::text
                END AS form_name,
                CASE
                    WHEN tfe.k IS NOT NULL THEN 'email'::text
                    WHEN tfp.k IS NOT NULL THEN 'phone'::text
                    WHEN tff.k IS NOT NULL THEN 'first_name'::text
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
    COALESCE(bo.audience, audience_display_name(ao.audience_slug),
        CASE
            WHEN regexp_replace(COALESCE(b.contact_phone, ''::text), '\D'::text, ''::text, 'g'::text) ~ '^61'::text THEN 'Australia'::text
            ELSE NULL::text
        END, NULLIF(fa.aud, 'Unknown'::text), NULLIF(mp.audience_from_utm, 'Unknown'::text), NULLIF(audience_from_campaign_name(b.booking_utm_campaign), 'Unknown'::text), aa.audience, sc.audience_hint, 'Unknown'::text) AS audience,
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
    b.contact_email ~* '@(opt\.co\.nz|optdigital\.io)$'::text OR b.contact_name ~* 'opt digital'::text AND (b.contact_email IS NULL OR b.contact_email = ''::text) OR b.prospect_name ~ '^[0-9]+$'::text OR length(b.prospect_name) <= 2 AND (b.contact_email IS NULL OR b.contact_email = ''::text) OR (lower(b.prospect_name) = ANY (ARRAY['test'::text, 'asdf'::text, 'dsd'::text, 'abc'::text, 'qwerty'::text, 'xxx'::text, 'sdfsdf'::text, 'dsdsd'::text, 'sdf'::text])) AS is_spam
   FROM bookings b
     JOIN strategy_calendars sc ON sc.id = b.calendar_name
     LEFT JOIN match_picked mp ON mp.id = b.id
     LEFT JOIN ads ad ON ad.ad_id = mp.tf_ad_id
     LEFT JOIN lib_ad_audience aa ON aa.ad_id = mp.tf_ad_id
     LEFT JOIN form_audience fa ON fa.form_name = mp.form_name
     LEFT JOIN booking_audience_overrides bo ON bo.booking_id = b.id
     LEFT JOIN ad_audience_overrides ao ON ao.ad_id = mp.tf_ad_id
UNION ALL
 SELECT md5(cb.invitee_uri)::uuid AS id,
    cb.invitee_uri AS ghl_event_id,
    NULL::text AS ghl_contact_id,
    cb.invitee_email AS contact_email,
    cb.invitee_name AS contact_name,
    'calendly:'::text || cb.event_type_uri AS calendar_name,
    (cb.booked_at AT TIME ZONE 'America/New_York'::text)::date AS booked_at,
    (cb.start_time AT TIME ZONE 'America/New_York'::text)::date AS appointment_date,
    'confirmed'::text AS appointment_status,
    NULL::text AS revenue_tier,
    false AS is_dq,
    'Australia'::text AS audience,
    'calendly_aus'::text AS audience_source,
    NULL::text AS resolved_ad_id,
    NULL::text AS resolved_campaign_id,
    NULL::text AS resolved_adset_id,
    NULL::text AS resolved_match_method,
    cb.invitee_email ~* '@(opt\.co\.nz|optdigital\.io)$'::text OR cb.invitee_name ~* '^(test|diamont)'::text AS is_spam
   FROM ( SELECT DISTINCT ON ((lower(COALESCE(NULLIF(cb_1.invitee_email, ''::text), cb_1.invitee_uri)))) cb_1.*
           FROM calendly_bookings cb_1
          WHERE cb_1.status <> 'canceled'::text AND (cb_1.event_type_uri = 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492'::text OR cb_1.event_name ~* '\(aus\)|australia'::text)
          ORDER BY (lower(COALESCE(NULLIF(cb_1.invitee_email, ''::text), cb_1.invitee_uri))), cb_1.booked_at DESC) cb;

CREATE OR REPLACE VIEW public.lib_close_audience AS
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
            WHEN ov.audience IS NOT NULL THEN ov.audience
            WHEN cr.resolved_campaign = 'REFERRAL'::text THEN 'Referral'::text
            WHEN cal_au.aud IS NOT NULL OR bk_exact.aud = 'Australia'::text THEN 'Australia'::text
            ELSE COALESCE(audience_display_name(ao.audience_slug), NULLIF(audience_from_campaign_name(cr.resolved_campaign), 'Unknown'::text), NULLIF(aa.audience, 'Unknown'::text), bk_exact.aud, bk.aud, 'Unknown'::text)
        END AS audience
   FROM lib_close_resolved_mv cr
     LEFT JOIN closer_calls cc ON cc.id = cr.closer_call_id
     LEFT JOIN closer_eod_reports cer ON cer.id = cc.eod_report_id
     LEFT JOIN LATERAL ( SELECT 'Australia'::text AS aud
           FROM calendly_bookings cbx
          WHERE cc.ghl_event_id IS NOT NULL AND cbx.invitee_uri = cc.ghl_event_id AND (cbx.event_type_uri = 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492'::text OR cbx.event_name ~* '\(aus\)|australia'::text)
         LIMIT 1) cal_au ON true
     LEFT JOIN close_attribution_overrides ov ON ov.closer_call_id = cr.closer_call_id
     LEFT JOIN ad_audience_overrides ao ON ao.ad_id = cr.resolved_ad_id
     LEFT JOIN lib_ad_audience aa ON aa.ad_id = cr.resolved_ad_id
     LEFT JOIN LATERAL ( SELECT bk_2.audience AS aud
           FROM lib_booking_resolved_mv bk_2
          WHERE bk_2.audience <> 'Unknown'::text AND NOT bk_2.is_spam AND cc.ghl_event_id IS NOT NULL AND cc.ghl_event_id <> ''::text AND bk_2.ghl_event_id = cc.ghl_event_id
         LIMIT 1) bk_exact ON true
     LEFT JOIN LATERAL ( SELECT bk_1.audience AS aud
           FROM lib_booking_resolved_mv bk_1
          WHERE bk_1.audience <> 'Unknown'::text AND NOT bk_1.is_spam AND (lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' and '::text, 1))) = lower(TRIM(BOTH FROM split_part(cr.prospect_name::text, ' and '::text, 1))) OR lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' - '::text, 1))) = lower(TRIM(BOTH FROM split_part(cr.prospect_name::text, ' - '::text, 1)))) AND bk_1.appointment_date IS NOT NULL AND abs(bk_1.appointment_date - COALESCE(cer.report_date, (cr.created_at AT TIME ZONE 'America/New_York'::text)::date)) <= 1
          ORDER BY bk_1.booked_at DESC NULLS LAST, bk_1.id
         LIMIT 1) bk ON true;

CREATE OR REPLACE VIEW public.lib_closer_call_audience AS
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
    COALESCE(cal_au.aud, cl.aud, bk_exact.aud, bk.aud, tf.aud, 'Unknown'::text) AS audience
   FROM closer_calls cc
     LEFT JOIN closer_eod_reports cer ON cer.id = cc.eod_report_id
     LEFT JOIN LATERAL ( SELECT 'Australia'::text AS aud
           FROM calendly_bookings cbx
          WHERE cc.ghl_event_id IS NOT NULL AND cbx.invitee_uri = cc.ghl_event_id AND (cbx.event_type_uri = 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492'::text OR cbx.event_name ~* '\(aus\)|australia'::text)
         LIMIT 1) cal_au ON true
     LEFT JOIN LATERAL ( SELECT ca.audience AS aud
           FROM lib_close_audience ca
          WHERE ca.closer_call_id = cc.id AND ca.audience <> 'Unknown'::text
         LIMIT 1) cl ON true
     LEFT JOIN LATERAL ( SELECT bk_1.audience AS aud
           FROM lib_booking_resolved_mv bk_1
          WHERE bk_1.audience <> 'Unknown'::text AND NOT bk_1.is_spam AND (lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' and '::text, 1))) = lower(TRIM(BOTH FROM split_part(cc.prospect_name::text, ' and '::text, 1))) OR lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' - '::text, 1))) = lower(TRIM(BOTH FROM split_part(cc.prospect_name::text, ' - '::text, 1)))) AND bk_1.appointment_date IS NOT NULL AND cer.report_date IS NOT NULL AND abs(bk_1.appointment_date - cer.report_date) <= 1
          ORDER BY bk_1.booked_at DESC NULLS LAST, bk_1.id
         LIMIT 1) bk ON true
     LEFT JOIN LATERAL ( SELECT bk_2.audience AS aud
           FROM lib_booking_resolved_mv bk_2
          WHERE bk_2.audience <> 'Unknown'::text AND NOT bk_2.is_spam AND cc.ghl_event_id IS NOT NULL AND cc.ghl_event_id <> ''::text AND bk_2.ghl_event_id = cc.ghl_event_id
         LIMIT 1) bk_exact ON true
     LEFT JOIN LATERAL ( SELECT audience_display_name(r.audience_slug) AS aud
           FROM typeform_responses t
             JOIN lib_typeform_audience_resolved r ON r.response_id = t.response_id
          WHERE r.audience_slug IS NOT NULL AND length(TRIM(BOTH FROM COALESCE(t.last_name, ''::text))) > 0 AND (lower(TRIM(BOTH FROM (COALESCE(t.first_name, ''::text) || ' '::text) || COALESCE(t.last_name, ''::text))) = ANY (ARRAY[lower(TRIM(BOTH FROM split_part(cc.prospect_name::text, ' and '::text, 1))), lower(TRIM(BOTH FROM split_part(cc.prospect_name::text, ' - '::text, 1)))]))
          ORDER BY t.submitted_at DESC NULLS LAST, t.response_id DESC
         LIMIT 1) tf ON true;

REFRESH MATERIALIZED VIEW public.lib_booking_resolved_mv;
REFRESH MATERIALIZED VIEW public.lib_close_resolved_mv;
REFRESH MATERIALIZED VIEW public.lib_marketing_by_audience_daily_mv;
