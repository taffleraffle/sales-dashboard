-- 186: a close takes its region from its own booking (Ben, 14 Sep 2026)
--
-- Filtered to Australia, the Overview said 1 close and $2,887 cash for the
-- week when Ash and Ben had closed two Australians (Rob Bult and David
-- Mikkelsen, 8 Sep). Rob Bult's close was attributed to a US Google ad that
-- carries no audience tag, and lib_ad_audience returns the literal 'Unknown'
-- for untagged ads. COALESCE stopped on that 'Unknown', so the booking match
-- behind it (his Australian Calendly booking) was never reached and the close
-- was counted as US. David Mikkelsen only read Australian because of a manual
-- override.
--
-- Now:
--   1. An exact calendar event match to an Australian booking decides the
--      region. The AUS Calendly event is a fact; a close-level ad match is not.
--   2. An untagged ad's 'Unknown' no longer blocks the booking fallbacks.
--   3. The name match to a booking must be within a day of the call, the same
--      guard migration 183 put on lib_closer_call_audience. First names repeat.
--
-- Measured before applying: 2 closes change audience, both from Unknown.
-- Rob Bult (8 Sep) -> Australia, Jeff Stovall RestorationConnect (20 Apr) ->
-- Restoration. No close that already had an audience moves.
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
            WHEN bk_exact.aud = 'Australia'::text THEN 'Australia'::text
            ELSE COALESCE(audience_display_name(ao.audience_slug), NULLIF(audience_from_campaign_name(cr.resolved_campaign), 'Unknown'::text), NULLIF(aa.audience, 'Unknown'::text), bk_exact.aud, bk.aud, 'Unknown'::text)
        END AS audience
   FROM lib_close_resolved_mv cr
     LEFT JOIN closer_calls cc ON cc.id = cr.closer_call_id
     LEFT JOIN closer_eod_reports cer ON cer.id = cc.eod_report_id
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

REFRESH MATERIALIZED VIEW public.lib_marketing_by_audience_daily_mv;
