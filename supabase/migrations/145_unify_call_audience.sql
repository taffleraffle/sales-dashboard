-- 145: unify call-audience attribution with the close-resolver chain.
--
-- lib_closer_call_audience resolved audience ONLY via strategy-booking name
-- match. lib_close_audience resolves via the full close-resolver chain
-- (resolved ad → campaign-name parse → booking match). The same human could
-- therefore carry different audiences in the two views: elijah smith
-- (closed 2026-06-05) was 'Electricians' in the closes tile but 'Unknown'
-- in net-new-live — so ALL showed 3 net-live / 2 closes while filtering to
-- Restoration+Electricians showed 2 net-live / 2 closes. Tiles disagreeing
-- about one person reads as "the data changes depending on the filter".
--
-- Fix: a call that maps to a resolved close inherits the close's audience
-- FIRST (strongest signal — it went through ad/campaign attribution); the
-- booking-name match stays as fallback for non-closing calls. Column list
-- and order are unchanged so every dependent view/query is unaffected.

create or replace view lib_closer_call_audience as
select
  cc.id as closer_call_id,
  cc.prospect_name,
  trim(both from split_part(cc.prospect_name::text, ' and '::text, 1)) as clean_first_part,
  trim(both from split_part(cc.prospect_name::text, ' - '::text, 1)) as strip_suffix,
  cc.call_type,
  cc.outcome,
  cc.revenue,
  cc.cash_collected,
  cc.offered_finance,
  cc.eod_report_id,
  cc.created_at,
  cer.report_date,
  cer.is_confirmed,
  coalesce(cl.aud, bk.aud, 'Unknown'::text) as audience
from closer_calls cc
  left join closer_eod_reports cer on cer.id = cc.eod_report_id
  left join lateral (
    select ca.audience as aud
    from lib_close_audience ca
    where ca.closer_call_id = cc.id
      and ca.audience <> 'Unknown'::text
    limit 1
  ) cl on true
  left join lateral (
    select bk_1.audience as aud
    from lib_strategy_booking_resolved bk_1
    where bk_1.audience <> 'Unknown'::text
      and not bk_1.is_spam
      and (
        lower(trim(both from split_part(bk_1.contact_name, ' and '::text, 1)))
          = lower(trim(both from split_part(cc.prospect_name::text, ' and '::text, 1)))
        or lower(trim(both from split_part(bk_1.contact_name, ' - '::text, 1)))
          = lower(trim(both from split_part(cc.prospect_name::text, ' - '::text, 1)))
      )
    limit 1
  ) bk on true;

-- Propagate to the tile/trend rollup immediately.
refresh materialized view lib_marketing_by_audience_daily_mv;
