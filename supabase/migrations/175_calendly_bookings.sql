-- 175: Australian Calendly bookings count as booked calls (Ben, 6 Sep 2026)
-- The AU funnel books on the Calendly event "Opt Digital | Strategy Call 1 (AUS)".
-- Those bookings never reach GoHighLevel, so the dashboard had zero Australian
-- bookings and no cost per booked call. The calendly-booking-slack function now
-- stores every booking here; the AUS event is unioned into the booking resolver
-- as audience Australia. US Calendly bookings are not unioned (they reach GHL).

CREATE TABLE IF NOT EXISTS public.calendly_bookings (
  invitee_uri      text PRIMARY KEY,
  event_uri        text,
  event_type_uri   text,
  event_name       text,
  status           text NOT NULL DEFAULT 'active',
  start_time       timestamptz,
  end_time         timestamptz,
  booked_at        timestamptz NOT NULL DEFAULT now(),
  invitee_name     text,
  invitee_email    text,
  invitee_phone    text,
  invitee_timezone text,
  utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text,
  host_email       text,
  host_name        text,
  reschedule_url   text,
  cancel_url       text,
  raw              jsonb,
  synced_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendly_bookings_event_type_idx ON public.calendly_bookings (event_type_uri, booked_at);
ALTER TABLE public.calendly_bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendly_bookings_read ON public.calendly_bookings;
CREATE POLICY calendly_bookings_read ON public.calendly_bookings FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.calendly_bookings TO anon, authenticated;
GRANT ALL ON public.calendly_bookings TO service_role;

-- Backfill: every booking on the AUS event as of 6 Sep 2026 (from the Calendly API)
INSERT INTO public.calendly_bookings
  (invitee_uri, event_uri, event_type_uri, event_name, status, start_time, booked_at, invitee_name, invitee_email, invitee_timezone, utm_source, utm_medium, utm_campaign, utm_content, utm_term, host_email, host_name)
VALUES
  ('https://api.calendly.com/scheduled_events/4dc592a2-58f8-4076-9861-edaaddd26905#pbyers69@bigpond.com', 'https://api.calendly.com/scheduled_events/4dc592a2-58f8-4076-9861-edaaddd26905', 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492', 'Opt Digital | Strategy Call 1 (AUS)', 'active', '2026-09-03T04:00:00Z', '2026-09-02T19:13:33Z', 'Paul Byers', 'pbyers69@bigpond.com', 'Australia/Sydney', NULL, NULL, NULL, NULL, NULL, 'ben@opt.co.nz', 'Ben Hobbs'),
  ('https://api.calendly.com/scheduled_events/ea38e7b6-f6c5-4942-9550-289f20b02210#davidpriceconcrete@gmail.com', 'https://api.calendly.com/scheduled_events/ea38e7b6-f6c5-4942-9550-289f20b02210', 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492', 'Opt Digital | Strategy Call 1 (AUS)', 'active', '2026-09-04T03:00:00Z', '2026-09-03T04:43:26Z', 'David Price', 'davidpriceconcrete@gmail.com', 'Australia/Sydney', NULL, NULL, NULL, NULL, NULL, 'ben@opt.co.nz', 'Ben Hobbs'),
  ('https://api.calendly.com/scheduled_events/f38eeb20-80ee-446f-b3f4-070ed7933db0#cindypsaila@gmail.com', 'https://api.calendly.com/scheduled_events/f38eeb20-80ee-446f-b3f4-070ed7933db0', 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492', 'Opt Digital | Strategy Call 1 (AUS)', 'active', '2026-09-04T03:00:00Z', '2026-09-03T20:15:30Z', 'dennis', 'cindypsaila@gmail.com', 'Australia/Sydney', NULL, NULL, NULL, NULL, NULL, 'daniel@optdigital.io', 'Daniel Gomez De Le Vega'),
  ('https://api.calendly.com/scheduled_events/04ae82bf-d5bb-4072-b438-e87e2a70432e#roder@bigpond.com', 'https://api.calendly.com/scheduled_events/04ae82bf-d5bb-4072-b438-e87e2a70432e', 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492', 'Opt Digital | Strategy Call 1 (AUS)', 'active', '2026-09-04T08:00:00Z', '2026-09-02T11:37:30Z', 'Allan', 'roder@bigpond.com', 'Australia/Sydney', NULL, NULL, NULL, NULL, NULL, 'ben@opt.co.nz', 'Ben Hobbs'),
  ('https://api.calendly.com/scheduled_events/e6dc85b5-499c-496b-9f4b-e4a11d152c82#kamrankhans88@gmail.com', 'https://api.calendly.com/scheduled_events/e6dc85b5-499c-496b-9f4b-e4a11d152c82', 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492', 'Opt Digital | Strategy Call 1 (AUS)', 'active', '2026-09-07T03:30:00Z', '2026-09-05T20:17:13Z', 'Kamran Khan', 'kamrankhans88@gmail.com', 'Australia/Sydney', NULL, NULL, NULL, NULL, NULL, 'ben@opt.co.nz', 'Ben Hobbs'),
  ('https://api.calendly.com/scheduled_events/6497752a-ac22-49f9-a23a-d6f30235ad89#chad@cgfsecurityandelectrical.com.au', 'https://api.calendly.com/scheduled_events/6497752a-ac22-49f9-a23a-d6f30235ad89', 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492', 'Opt Digital | Strategy Call 1 (AUS)', 'active', '2026-09-07T05:00:00Z', '2026-09-02T21:03:01Z', 'Chad Mckelvey', 'chad@cgfsecurityandelectrical.com.au', 'Australia/Sydney', NULL, NULL, NULL, NULL, NULL, 'ben@opt.co.nz', 'Ben Hobbs'),
  ('https://api.calendly.com/scheduled_events/445879dc-e674-4c95-a5b6-1b36318c5314#yonatantal17@gmail.com', 'https://api.calendly.com/scheduled_events/445879dc-e674-4c95-a5b6-1b36318c5314', 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492', 'Opt Digital | Strategy Call 1 (AUS)', 'active', '2026-09-07T06:00:00Z', '2026-09-02T13:09:45Z', 'Johnny T', 'yonatantal17@gmail.com', 'Australia/Sydney', 'facebook', 'Adv +', 'OPT | GMB - BROAD - LEAD FORM - 2026-09', 'TOON-HOME-gmb-onecity', '120252064040770530', 'ben@opt.co.nz', 'Ben Hobbs'),
  ('https://api.calendly.com/scheduled_events/c9976a1d-ed7f-4fbb-8f49-7d6e149fb949#mark@carpetcleaning.com.au', 'https://api.calendly.com/scheduled_events/c9976a1d-ed7f-4fbb-8f49-7d6e149fb949', 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492', 'Opt Digital | Strategy Call 1 (AUS)', 'active', '2026-09-08T03:00:00Z', '2026-09-04T09:07:05Z', 'Mark Stachnik', 'mark@carpetcleaning.com.au', 'Australia/Brisbane', NULL, NULL, NULL, NULL, NULL, 'ben@opt.co.nz', 'Ben Hobbs'),
  ('https://api.calendly.com/scheduled_events/680f4fb5-cd33-4cd2-93fe-dcb601cd1416#ben@opt.co.nz', 'https://api.calendly.com/scheduled_events/680f4fb5-cd33-4cd2-93fe-dcb601cd1416', 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492', 'Opt Digital | Strategy Call 1 (AUS)', 'active', '2026-09-09T04:00:00Z', '2026-09-06T05:55:05Z', 'Benjamin', 'ben@opt.co.nz', 'Pacific/Auckland', 'facebook-au', NULL, NULL, NULL, NULL, 'ben@opt.co.nz', 'Ben Hobbs'),
  ('https://api.calendly.com/scheduled_events/2aff41f8-98ef-49fb-99a0-30b43b319f6f#ben@opt.co.nz', 'https://api.calendly.com/scheduled_events/2aff41f8-98ef-49fb-99a0-30b43b319f6f', 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492', 'Opt Digital | Strategy Call 1 (AUS)', 'canceled', '2026-09-09T04:30:00Z', '2026-09-06T03:14:13Z', 'Diamont', 'ben@opt.co.nz', 'Pacific/Auckland', 'facebook-au', NULL, NULL, NULL, NULL, 'ben@opt.co.nz', 'Ben Hobbs'),
  ('https://api.calendly.com/scheduled_events/0cb34678-3111-4a6d-be0d-94e65e50e437#info@marcoplumbing.com.au', 'https://api.calendly.com/scheduled_events/0cb34678-3111-4a6d-be0d-94e65e50e437', 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492', 'Opt Digital | Strategy Call 1 (AUS)', 'active', '2026-09-09T05:30:00Z', '2026-09-05T06:13:19Z', 'Velle', 'info@marcoplumbing.com.au', 'Australia/Sydney', NULL, NULL, NULL, NULL, NULL, 'daniel@optdigital.io', 'Daniel Gomez De Le Vega'),
  ('https://api.calendly.com/scheduled_events/87d9ad49-05bc-476c-aa1f-d3e4ce2a7d84#luke@nextlevelstrata.com.au', 'https://api.calendly.com/scheduled_events/87d9ad49-05bc-476c-aa1f-d3e4ce2a7d84', 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492', 'Opt Digital | Strategy Call 1 (AUS)', 'active', '2026-09-09T06:00:00Z', '2026-09-04T17:43:29Z', 'Luke Luke', 'luke@nextlevelstrata.com.au', 'Australia/Sydney', NULL, NULL, NULL, NULL, NULL, 'ben@opt.co.nz', 'Ben Hobbs')
ON CONFLICT (invitee_uri) DO NOTHING;

-- Union the AUS event into the booking resolver
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
    b.contact_name ~* 'opt digital'::text OR b.prospect_name ~ '^[0-9]+$'::text OR length(b.prospect_name) <= 2 AND (b.contact_email IS NULL OR b.contact_email = ''::text) OR (lower(b.prospect_name) = ANY (ARRAY['test'::text, 'asdf'::text, 'dsd'::text, 'abc'::text, 'qwerty'::text, 'xxx'::text, 'sdfsdf'::text, 'dsdsd'::text, 'sdf'::text])) AS is_spam
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
    ('calendly:'::text || cb.event_type_uri) AS calendar_name,
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
    (cb.invitee_email ~* '@(opt\.co\.nz|optdigital\.io)$'::text OR cb.invitee_name ~* '^(test|diamont)'::text) AS is_spam
   FROM calendly_bookings cb
  WHERE cb.status <> 'canceled'::text
    AND (cb.event_type_uri = 'https://api.calendly.com/event_types/33d4141c-266a-48bf-a62a-4800c8aaf492'::text OR cb.event_name ~* '\(aus\)|australia'::text);
