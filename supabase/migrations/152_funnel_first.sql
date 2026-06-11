-- 152: FUNNEL-FIRST attribution — the typeform/funnel a lead actually
-- filled outranks ad-id attribution.
--
-- Evidence (2026-06-11): Meta campaign duplication ("- Copy") cross-wired
-- ad_ids — 6 of 60 last-30d Restoration-Funnel leads (incl. live-call
-- prospects Andrew Mason, Anthony, Richard Peterson) carried ad_ids living
-- under "SCIO - Electricians - VSL - New SEO Rules" even though BOTH their
-- form AND their utm_campaign said Restoration. The ad chain outranked the
-- funnel, so the Electricians filter showed 4 live calls and Restoration 0.
-- The funnel a person fills is ground truth for which offer they're in.
--
-- New precedence, applied consistently:
--   1. manual row override (booking_audience_overrides / close_attribution_overrides)
--   2. manual per-ad override (ad_audience_overrides)
--   3. FUNNEL — typeform form_name parse
--   4. UTM campaign-name parse
--   5. ad chain (lib_ad_audience: campaign override + campaign-name parse)
--   6. calendar hint / booking fallback
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

-- Typeform lead resolution: same precedence at lead level.
create or replace view public.lib_typeform_audience_resolved as
select
  tr.response_id,
  coalesce(ro.audience_slug, ao.audience_slug, form_slug.slug, co.audience_slug, utm_slug.slug, ad_slug.slug) as audience_slug,
  case
    when ro.audience_slug is not null then 'response_override'
    when ao.audience_slug is not null then 'ad_override'
    when form_slug.slug is not null then 'funnel'
    when co.audience_slug is not null then 'campaign_override'
    when utm_slug.slug is not null then 'parsed'
    when ad_slug.slug is not null then 'ad_resolved'
    else 'unknown'
  end as audience_source,
  coalesce(ro.ad_id, tr.ad_id) as ad_id
from typeform_responses tr
left join typeform_response_overrides ro on ro.response_id = tr.response_id
left join ad_audience_overrides ao on ao.ad_id = coalesce(ro.ad_id, tr.ad_id)
left join campaign_audience_overrides co on co.campaign_id = tr.utm_campaign
left join lib_ad_audience laa on laa.ad_id = coalesce(ro.ad_id, tr.ad_id)
left join lateral (
  select d.slug from audience_definitions d
  where d.is_active and tr.form_name is not null
    and exists (select 1 from unnest(d.keywords) kw where tr.form_name ilike '%' || kw || '%')
  order by d.sort_order asc, d.slug asc limit 1
) form_slug on true
left join lateral (
  select d.slug from audience_definitions d
  where d.is_active and tr.utm_campaign is not null
    and exists (select 1 from unnest(d.keywords) kw where tr.utm_campaign ilike '%' || kw || '%')
  order by d.sort_order asc, d.slug asc limit 1
) utm_slug on true
left join lateral (
  select d.slug from audience_definitions d
  where d.display_name = laa.audience
  order by d.sort_order asc, d.slug asc limit 1
) ad_slug on true;

-- Closes: per-ad override + UTM/campaign parse outrank the ad chain.
-- (resolved_campaign is the lead's utm_campaign for typeform/appointment/
-- GHL-matched closes, so the funnel-aligned signal wins; the booking
-- fallback bk.aud is itself funnel-first now.)
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
            ELSE COALESCE(
              audience_display_name(ao.audience_slug),
              NULLIF(audience_from_campaign_name(cr.resolved_campaign), 'Unknown'::text),
              aa.audience,
              bk.aud,
              'Unknown'::text)
        END AS audience
   FROM lib_close_resolved_mv cr
     LEFT JOIN close_attribution_overrides ov ON ov.closer_call_id = cr.closer_call_id
     LEFT JOIN ad_audience_overrides ao ON ao.ad_id = cr.resolved_ad_id
     LEFT JOIN lib_ad_audience aa ON aa.ad_id = cr.resolved_ad_id
     LEFT JOIN LATERAL ( SELECT bk_1.audience AS aud
           FROM lib_booking_resolved_mv bk_1
          WHERE bk_1.audience <> 'Unknown'::text AND NOT bk_1.is_spam
            AND (lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' and '::text, 1))) = lower(TRIM(BOTH FROM split_part(cr.prospect_name::text, ' and '::text, 1)))
              OR lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' - '::text, 1))) = lower(TRIM(BOTH FROM split_part(cr.prospect_name::text, ' - '::text, 1))))
          ORDER BY bk_1.booked_at DESC NULLS LAST, bk_1.id
         LIMIT 1) bk ON true;

-- Rebuild the snapshots so everything propagates now.
select public.refresh_marketing_trend_mv();
