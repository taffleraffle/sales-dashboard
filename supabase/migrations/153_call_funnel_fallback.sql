-- 153: live calls fall back to the prospect's OWN typeform funnel.
--
-- Non-closed live calls resolved audience only via (a) the close chain or
-- (b) a name-matched booking. Calls like "Kenzi Touadi - RestorationConnect
-- Strategy Call" (booking saved as just "Kenzi") or Hugo Cedeno (no booking
-- row at all) matched neither and sat in Unknown even though their typeform
-- says exactly which funnel they filled. New last-resort rung: exact
-- full-name (first+last) match against typeform_responses → that lead's
-- funnel-first audience. Full-name equality only — no first-name-only
-- cross-matching.

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
    COALESCE(cl.aud, bk.aud, tf.aud, 'Unknown'::text) AS audience
   FROM closer_calls cc
     LEFT JOIN closer_eod_reports cer ON cer.id = cc.eod_report_id
     LEFT JOIN LATERAL ( SELECT ca.audience AS aud
           FROM lib_close_audience ca
          WHERE ca.closer_call_id = cc.id AND ca.audience <> 'Unknown'::text
         LIMIT 1) cl ON true
     LEFT JOIN LATERAL ( SELECT bk_1.audience AS aud
           FROM lib_booking_resolved_mv bk_1
          WHERE bk_1.audience <> 'Unknown'::text AND NOT bk_1.is_spam
            AND (lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' and '::text, 1))) = lower(TRIM(BOTH FROM split_part(cc.prospect_name::text, ' and '::text, 1)))
              OR lower(TRIM(BOTH FROM split_part(bk_1.contact_name, ' - '::text, 1))) = lower(TRIM(BOTH FROM split_part(cc.prospect_name::text, ' - '::text, 1))))
          ORDER BY bk_1.booked_at DESC NULLS LAST, bk_1.id
         LIMIT 1) bk ON true
     LEFT JOIN LATERAL ( SELECT audience_display_name(r.audience_slug) AS aud
           FROM typeform_responses t
           JOIN lib_typeform_audience_resolved r ON r.response_id = t.response_id
          WHERE r.audience_slug IS NOT NULL
            AND length(TRIM(coalesce(t.last_name, ''))) > 0
            AND lower(TRIM(coalesce(t.first_name,'') || ' ' || coalesce(t.last_name,''))) IN (
              lower(TRIM(BOTH FROM split_part(cc.prospect_name::text, ' and '::text, 1))),
              lower(TRIM(BOTH FROM split_part(cc.prospect_name::text, ' - '::text, 1))))
          ORDER BY t.submitted_at DESC NULLS LAST, t.response_id DESC
         LIMIT 1) tf ON true;

select public.refresh_marketing_trend_mv();
