-- 149: edit a prospect's funnel/audience from the dashboard.
--
-- Until now the only way to correct attribution was hand-written SQL
-- (close_attribution_overrides inserts). This migration makes both
-- correction points first-class so the UI can write them:
--
-- 1. close_attribution_overrides.audience — a direct audience override for
--    a close. lib_close_audience now honors it FIRST (before REFERRAL/ad/
--    campaign/booking resolution). The old utm_campaign-based override
--    still works as before when audience is null.
-- 2. booking_audience_overrides — per-booking audience override, honored
--    first by lib_strategy_booking_resolved (audience_source = 'manual').
--
-- The dashboard's Closes drilldown (Audience column) and Bookings
-- drilldowns (Funnel column) become editable dropdowns that upsert these
-- tables and refresh the trend MV.

-- booking_id is ghl_appointments.id (uuid). A first cut typed it text and
-- the view join failed with "operator does not exist: text = uuid" — drop
-- the empty mistyped table if that run left it behind.
drop table if exists public.booking_audience_overrides;
create table public.booking_audience_overrides (
  booking_id uuid primary key,
  audience text not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.close_attribution_overrides add column if not exists audience text;

create or replace view public.lib_strategy_booking_resolved as
 WITH strategy_calendars AS (
         SELECT cid.cid AS id,
            a.display_name AS audience_hint,
            a.is_dq
           FROM audience_definitions a,
            LATERAL unnest(a.calendar_ids) cid(cid)
          WHERE a.is_active
        UNION ALL
         SELECT 'gohFzPCilzwBtVfaC6fu'::text,
            NULL::text,
            true
        UNION ALL
         SELECT 'T5Zif5GjDwulya6novU0'::text,
            NULL::text,
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
            a.booked_at::date AS booked_at,
            a.appointment_date,
            a.appointment_status,
            a.revenue_tier
           FROM ghl_appointments a
             JOIN strategy_calendars sc_1 ON sc_1.id = a.calendar_name
          WHERE a.appointment_status <> 'cancelled'::text
          ORDER BY (COALESCE(a.ghl_contact_id, a.contact_email)), a.booked_at
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
    COALESCE(bo.audience, aa.audience, NULLIF(mp.audience_from_utm, 'Unknown'::text), NULLIF(fa.aud, 'Unknown'::text), sc.audience_hint, 'Unknown'::text) AS audience,
        CASE
            WHEN bo.audience IS NOT NULL THEN 'manual'::text
            WHEN aa.audience IS NOT NULL THEN ('typeform_ad_id('::text || mp.match_method) || ')'::text
            WHEN NULLIF(mp.audience_from_utm, 'Unknown'::text) IS NOT NULL THEN ('typeform_utm('::text || mp.match_method) || ')'::text
            WHEN NULLIF(fa.aud, 'Unknown'::text) IS NOT NULL THEN ('typeform_form('::text || mp.match_method) || ')'::text
            WHEN sc.audience_hint IS NOT NULL THEN 'calendar_hint'::text
            ELSE 'unresolved'::text
        END AS audience_source,
    mp.tf_ad_id AS resolved_ad_id,
    ad.campaign_id AS resolved_campaign_id,
    ad.adset_id AS resolved_adset_id,
    mp.match_method AS resolved_match_method,
    b.prospect_name ~ '^[0-9]+$'::text OR length(b.prospect_name) <= 2 AND (b.contact_email IS NULL OR b.contact_email = ''::text) OR (lower(b.prospect_name) = ANY (ARRAY['test'::text, 'asdf'::text, 'dsd'::text, 'abc'::text, 'qwerty'::text, 'xxx'::text, 'sdfsdf'::text, 'dsdsd'::text, 'sdf'::text])) AS is_spam
   FROM bookings b
     JOIN strategy_calendars sc ON sc.id = b.calendar_name
     LEFT JOIN match_picked mp ON mp.id = b.id
     LEFT JOIN ads ad ON ad.ad_id = mp.tf_ad_id
     LEFT JOIN lib_ad_audience aa ON aa.ad_id = mp.tf_ad_id
     LEFT JOIN form_audience fa ON fa.form_name = mp.form_name
     LEFT JOIN booking_audience_overrides bo ON bo.booking_id = b.id;

-- lib_close_audience: direct audience override wins over everything,
-- including the REFERRAL campaign mapping. Otherwise identical to 147.
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
            WHEN ov.audience IS NOT NULL THEN ov.audience
            WHEN cr.resolved_campaign = 'REFERRAL'::text THEN 'Referral'::text
            ELSE COALESCE(aa.audience, NULLIF(audience_from_campaign_name(cr.resolved_campaign), 'Unknown'::text), bk.aud, 'Unknown'::text)
        END AS audience
   FROM lib_close_resolved cr
     LEFT JOIN close_attribution_overrides ov ON ov.closer_call_id = cr.closer_call_id
     LEFT JOIN lib_ad_audience aa ON aa.ad_id = cr.resolved_ad_id
     LEFT JOIN LATERAL ( SELECT bk_1.audience AS aud
           FROM lib_strategy_booking_resolved bk_1
          WHERE bk_1.audience <> 'Unknown'::text AND NOT bk_1.is_spam
            AND (lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' and '::text, 1))) = lower(TRIM(BOTH FROM split_part(cr.prospect_name::text, ' and '::text, 1)))
              OR lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' - '::text, 1))) = lower(TRIM(BOTH FROM split_part(cr.prospect_name::text, ' - '::text, 1))))
          ORDER BY bk_1.booked_at DESC NULLS LAST, bk_1.id
         LIMIT 1) bk ON true;

-- Propagate to the tiles immediately.
select public.refresh_marketing_trend_mv();
