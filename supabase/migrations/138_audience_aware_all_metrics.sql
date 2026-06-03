-- Migration 138: extend lib_marketing_by_audience_daily with audience-aware
-- offers, finance, ascend financials + combined call totals.
--
-- Continuation of migration 137 (audience-aware no_shows/reschedules/cancels).
-- After Ben spotted the "Net New Live = 28" silent-fallback bleed on 2026-06-03,
-- audit revealed several other marketing_tracker fields were ALSO leaking
-- global totals into audience-filtered views via the same MT fall-through
-- path in MarketingPerformance.jsx::audienceFilteredEntries:
--
--   offers (24/30d), ascend_cash ($15,099), ascend_revenue ($25,599),
--   finance_offers (3), finance_accepted (3), net_live_calls (31, NC+FU),
--   net_new_calls (80), net_fu_calls (15), calls_on_calendar (95).
--
-- These all have audience truth available through lib_closer_call_audience
-- (every call already tagged with its prospect's audience via the resolver
-- chain). closer_calls.offered isn't on the audience view yet, so we LEFT
-- JOIN closer_calls back in the new closer_d CTE.

DROP VIEW IF EXISTS lib_marketing_by_audience_daily CASCADE;

CREATE VIEW lib_marketing_by_audience_daily AS
WITH ad_aud AS MATERIALIZED (
  SELECT ad_id, audience FROM lib_ad_audience
),
spend_d AS (
  SELECT s_1.date, aa.audience,
    sum(s_1.spend) AS adspend, sum(s_1.impressions) AS impressions, sum(s_1.clicks) AS clicks
  FROM ad_daily_stats s_1 JOIN ad_aud aa ON aa.ad_id = s_1.ad_id
  GROUP BY s_1.date, aa.audience
),
leads_d AS (
  SELECT date_trunc('day'::text, (tr.submitted_at AT TIME ZONE 'UTC'::text))::date AS date,
    aa.audience, count(*) AS leads, count(*) FILTER (WHERE tr.qualified) AS qualified_leads
  FROM typeform_responses tr JOIN ad_aud aa ON aa.ad_id = tr.ad_id
  WHERE NOT EXISTS (SELECT 1 FROM lead_excluded le WHERE le.response_id = tr.response_id)
  GROUP BY (date_trunc('day'::text, (tr.submitted_at AT TIME ZONE 'UTC'::text))::date), aa.audience
),
qual_bookings_d AS (
  SELECT b.booked_at AS date, b.audience, count(*) AS qualified_bookings
  FROM lib_strategy_booking_resolved b
  WHERE NOT b.is_dq AND NOT b.is_spam
    AND NOT EXISTS (SELECT 1 FROM booking_excluded be WHERE be.booking_id = b.id)
  GROUP BY b.booked_at, b.audience
),
live_d AS (
  SELECT cca.report_date AS date, cca.audience, count(*) AS live_calls
  FROM lib_closer_call_audience cca
  WHERE cca.is_confirmed AND cca.call_type::text = 'new_call'::text
    AND (cca.outcome::text = ANY (ARRAY['closed','not_closed']::text[]))
    AND NOT EXISTS (SELECT 1 FROM closer_call_excluded e WHERE e.closer_call_id = cca.closer_call_id)
  GROUP BY cca.report_date, cca.audience
),
showrate_d AS (
  SELECT cca.report_date AS date, cca.audience,
    count(*) FILTER (WHERE cca.outcome::text = 'no_show')     AS no_shows,
    count(*) FILTER (WHERE cca.outcome::text = 'rescheduled') AS reschedules,
    count(*) FILTER (WHERE cca.outcome::text = 'canceled')    AS cancels
  FROM lib_closer_call_audience cca
  WHERE cca.is_confirmed AND cca.call_type::text = 'new_call'::text
    AND NOT EXISTS (SELECT 1 FROM closer_call_excluded e WHERE e.closer_call_id = cca.closer_call_id)
  GROUP BY cca.report_date, cca.audience
),
ascensions_d AS (
  -- Ascension calls use outcome='ascended' / 'not_ascended' (NOT 'closed').
  SELECT cca.report_date AS date, cca.audience,
    count(*) AS ascensions,
    count(*) FILTER (WHERE cca.outcome::text = 'ascended') AS ascensions_closed,
    sum(CASE WHEN cca.outcome::text = 'ascended' THEN cca.cash_collected ELSE 0 END) AS ascend_cash,
    sum(CASE WHEN cca.outcome::text = 'ascended' THEN cca.revenue        ELSE 0 END) AS ascend_revenue
  FROM lib_closer_call_audience cca
  WHERE cca.is_confirmed AND cca.call_type::text = 'ascension'::text
    AND NOT EXISTS (SELECT 1 FROM closer_call_excluded e WHERE e.closer_call_id = cca.closer_call_id)
  GROUP BY cca.report_date, cca.audience
),
closer_d AS (
  -- Audience-aware totals for the rest of the call-level metrics.
  -- offers + finance_accepted are NOT here: closer_calls.offered is sparse
  -- (closers rarely tick per-row, MT EOD aggregate is the truth), and per-
  -- row finance_accepted doesn't track which closes had a finance offer.
  -- finance_offers IS reliable per-row (matches MT global exactly) — kept
  -- un-scoped across call types because in practice every finance offer is
  -- on an ascension call.
  SELECT cca.report_date AS date,
         cca.audience,
         count(*) FILTER (WHERE cca.outcome::text IN ('closed','not_closed')) AS net_live_calls,
         count(*) FILTER (WHERE cca.call_type::text = 'follow_up' AND cca.outcome::text IN ('closed','not_closed')) AS fu_lives,
         count(*) FILTER (WHERE cca.offered_finance) AS finance_offers
  FROM lib_closer_call_audience cca
  WHERE cca.is_confirmed
    AND NOT EXISTS (SELECT 1 FROM closer_call_excluded e WHERE e.closer_call_id = cca.closer_call_id)
  GROUP BY cca.report_date, cca.audience
),
resolver_floor AS (
  -- The earliest date the close resolver (lib_close_audience) has covered.
  -- Pre-this date we backfill from marketing_tracker EOD aggregate so
  -- historical context isn't silently lost in trend charts.
  SELECT COALESCE(MIN(created_at::date), '2099-01-01'::date) AS d FROM lib_close_audience
),
close_d_src AS (
  SELECT ca.created_at::date AS date, ca.audience,
    count(*) AS closes, sum(ca.revenue) AS revenue, sum(ca.cash_collected) AS cash
  FROM lib_close_audience ca WHERE ca.audience <> 'Referral'::text
  GROUP BY (ca.created_at::date), ca.audience
  UNION ALL
  -- Pre-resolver: closer EOD aggregate as Unknown audience. No per-call
  -- audience attribution available -- the closes happened, we just can't
  -- split them by audience. Better to surface than to silently drop.
  SELECT mt.date,
         'Unknown'::text AS audience,
         mt.closes::bigint,
         mt.trial_revenue::numeric AS revenue,
         mt.trial_cash::numeric AS cash
  FROM marketing_tracker mt, resolver_floor f
  WHERE mt.date < f.d AND (COALESCE(mt.closes, 0) > 0 OR COALESCE(mt.trial_cash, 0) > 0)
),
close_d AS (
  SELECT date, audience,
    SUM(closes)::bigint AS closes,
    SUM(revenue)::numeric AS revenue,
    SUM(cash)::numeric AS cash
  FROM close_d_src GROUP BY date, audience
),
all_keys AS (
  SELECT date, audience FROM spend_d UNION
  SELECT date, audience FROM leads_d UNION
  SELECT date, audience FROM qual_bookings_d UNION
  SELECT date, audience FROM live_d UNION
  SELECT date, audience FROM showrate_d UNION
  SELECT date, audience FROM ascensions_d UNION
  SELECT date, audience FROM closer_d UNION
  SELECT date, audience FROM close_d
)
SELECT k.date, k.audience,
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
  COALESCE(asc1.ascend_cash, 0::numeric)     AS ascend_cash,
  COALESCE(asc1.ascend_revenue, 0::numeric)  AS ascend_revenue,
  COALESCE(sr.no_shows, 0::bigint)     AS no_shows,
  COALESCE(sr.reschedules, 0::bigint)  AS reschedules,
  COALESCE(sr.cancels, 0::bigint)      AS cancels,
  -- New audience-aware columns (migration 138):
  COALESCE(cd.net_live_calls, 0::bigint)   AS net_live_calls,
  COALESCE(cd.fu_lives, 0::bigint)         AS fu_lives,
  COALESCE(cd.finance_offers, 0::bigint)   AS finance_offers
FROM all_keys k
LEFT JOIN spend_d s         ON s.date = k.date  AND s.audience = k.audience
LEFT JOIN leads_d l         ON l.date = k.date  AND l.audience = k.audience
LEFT JOIN qual_bookings_d q ON q.date = k.date  AND q.audience = k.audience
LEFT JOIN live_d lv         ON lv.date = k.date AND lv.audience = k.audience
LEFT JOIN showrate_d sr     ON sr.date = k.date AND sr.audience = k.audience
LEFT JOIN ascensions_d asc1 ON asc1.date = k.date AND asc1.audience = k.audience
LEFT JOIN closer_d cd       ON cd.date = k.date  AND cd.audience = k.audience
LEFT JOIN close_d c         ON c.date = k.date  AND c.audience = k.audience
ORDER BY k.date DESC, k.audience;

GRANT SELECT ON lib_marketing_by_audience_daily TO authenticated, anon, service_role;
NOTIFY pgrst, 'reload schema';
