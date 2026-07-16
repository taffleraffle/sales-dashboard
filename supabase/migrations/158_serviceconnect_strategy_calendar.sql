-- 158: Allowlist the ServiceConnect strategy-call calendar (Ben 2026-07-16).
--
-- BUG: ServiceConnect (el8rJciCrMWpWiH1ulGc — "ServiceConnect Strategy Call")
-- launched its own strategy calendar but it was never added to the
-- strategy_calendars allowlist in lib_strategy_booking_resolved. That CTE is
-- INNER-JOINed against ghl_appointments, so every booking on the calendar was
-- silently dropped from qualified_bookings, the CPQB chart, and the drilldown.
-- ~30 real strategy calls since ~2026-05-29 went uncounted, including Abe
-- Kaskas and Mark Thurber.
--
-- ServiceConnect is a SHARED calendar that spans two funnels: of the 30
-- bookings, 18 filled the Electrician Funnel, 8 the Restoration Funnel, 4 have
-- no typeform record. So it must NOT carry a single-audience calendar hint —
-- it's the same case as the generic "Opt Digital | Strategy" calendar
-- (T5Zif…), which is allowlisted with a NULL hint so the funnel-first resolver
-- (form_name → audience, precedence #3) tags each prospect correctly and only
-- true orphans fall through to 'Unknown'.
--
-- Fix: add el8rJciCrMWpWiH1ulGc as a NULL-hint UNION ALL entry (mirroring the
-- T5Zif generic calendar), then refresh the matviews so the ~30 backlogged
-- bookings backfill immediately. Mirrored in src/utils/constants.js
-- STRATEGY_CALL_CALENDARS so the GHL sync scan and JS-side counts stay in sync.
--
-- This reproduces the live view from 152_funnel_first.sql verbatim, adding a
-- single UNION ALL line. Non-concurrent REFRESH is used deliberately: this
-- migration runs in a transaction and REFRESH ... CONCURRENTLY cannot.

BEGIN;

create or replace view public.lib_strategy_booking_resolved as
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
         SELECT 'el8rJciCrMWpWiH1ulGc'::text AS text,   -- ServiceConnect Strategy Call (shared: Electricians + Restoration; funnel decides)
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
    COALESCE(bo.audience, audience_display_name(ao.audience_slug), NULLIF(fa.aud, 'Unknown'::text), NULLIF(mp.audience_from_utm, 'Unknown'::text), aa.audience, sc.audience_hint, 'Unknown'::text) AS audience,
        CASE
            WHEN bo.audience IS NOT NULL THEN 'manual'::text
            WHEN audience_display_name(ao.audience_slug) IS NOT NULL THEN 'ad_override'::text
            WHEN NULLIF(fa.aud, 'Unknown'::text) IS NOT NULL THEN ('funnel('::text || mp.match_method) || ')'::text
            WHEN NULLIF(mp.audience_from_utm, 'Unknown'::text) IS NOT NULL THEN ('typeform_utm('::text || mp.match_method) || ')'::text
            WHEN aa.audience IS NOT NULL THEN ('typeform_ad_id('::text || mp.match_method) || ')'::text
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
     LEFT JOIN booking_audience_overrides bo ON bo.booking_id = b.id
     LEFT JOIN ad_audience_overrides ao ON ao.ad_id = mp.tf_ad_id;

-- Backfill the matviews so the ~30 ServiceConnect bookings appear immediately.
-- Order matches refresh_marketing_trend_mv(): bookings → closes → audience daily.
REFRESH MATERIALIZED VIEW lib_booking_resolved_mv;
REFRESH MATERIALIZED VIEW lib_close_resolved_mv;
REFRESH MATERIALIZED VIEW lib_marketing_by_audience_daily_mv;

NOTIFY pgrst, 'reload schema';

COMMIT;
