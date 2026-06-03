-- Migration 137: lead / closer-call exclusion tables + audience-aware show metrics
--
-- Problems this fixes:
--
-- 1. When an audience filter is on (Electricians, Restoration, etc.) the
--    KPI strip shows `no_shows / reschedules / cancels` sourced from
--    marketing_tracker, which is date-level and audience-blind. Result:
--    Electricians 30d shows 15 no-shows when the audience truth is 3.
--    The fix is to source those three counts from lib_closer_call_audience
--    (already audience-tagged via lib_closer_call_audience.audience).
--
-- 2. Spammy leads (elonmusk1957@proton.me, test@gmail.com, null-email rows)
--    and duplicate-submit leads (Casey Jones, Bruce Price etc.) inflate the
--    leads count. typeform_responses has no exclusion column and we don't
--    want to mutate the raw sync target, so we add an external exclusion
--    table joined into the lead CTE.
--
-- 3. Closer-call rows occasionally need individual exclusion (test entries,
--    misattributed prospects). closer_calls has no exclusion column.

-- ---------------------------------------------------------------------------
-- 1. lead_excluded — soft-delete for typeform_responses
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_excluded (
  response_id  TEXT PRIMARY KEY REFERENCES typeform_responses(response_id) ON DELETE CASCADE,
  reason       TEXT NOT NULL CHECK (reason IN ('spam', 'duplicate', 'test', 'manual', 'dq')),
  notes        TEXT,
  excluded_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  excluded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_excluded_excluded_at ON lead_excluded(excluded_at DESC);

ALTER TABLE lead_excluded ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_excluded_authenticated ON lead_excluded;
CREATE POLICY lead_excluded_authenticated ON lead_excluded
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON lead_excluded TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_excluded TO service_role;

-- ---------------------------------------------------------------------------
-- 2. closer_call_excluded — soft-delete for closer_calls rows
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS closer_call_excluded (
  closer_call_id  UUID PRIMARY KEY REFERENCES closer_calls(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL CHECK (reason IN ('spam', 'duplicate', 'test', 'manual', 'wrong_audience', 'dq')),
  notes           TEXT,
  excluded_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  excluded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_closer_call_excluded_excluded_at ON closer_call_excluded(excluded_at DESC);

ALTER TABLE closer_call_excluded ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS closer_call_excluded_authenticated ON closer_call_excluded;
CREATE POLICY closer_call_excluded_authenticated ON closer_call_excluded
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON closer_call_excluded TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON closer_call_excluded TO service_role;

-- ---------------------------------------------------------------------------
-- 3. lib_marketing_by_audience_daily — extend with audience-aware
--    no_shows / reschedules / cancels + respect lead_excluded.
-- ---------------------------------------------------------------------------
-- Keep all existing columns; add 3 new ones at the end so callers that
-- pin column order don't break. Filter lead_excluded out of leads_d.
DROP VIEW IF EXISTS lib_marketing_by_audience_daily CASCADE;

CREATE VIEW lib_marketing_by_audience_daily AS
WITH spend_d AS (
  SELECT s_1.date,
         aa.audience,
         sum(s_1.spend)        AS adspend,
         sum(s_1.impressions)  AS impressions,
         sum(s_1.clicks)       AS clicks
    FROM ad_daily_stats s_1
    JOIN lib_ad_audience aa ON aa.ad_id = s_1.ad_id
   GROUP BY s_1.date, aa.audience
),
leads_d AS (
  SELECT date_trunc('day'::text, (tr.submitted_at AT TIME ZONE 'UTC'::text))::date AS date,
         aa.audience,
         count(*)                                       AS leads,
         count(*) FILTER (WHERE tr.qualified)           AS qualified_leads
    FROM typeform_responses tr
    JOIN lib_ad_audience aa ON aa.ad_id = tr.ad_id
   WHERE NOT EXISTS (
           SELECT 1 FROM lead_excluded le WHERE le.response_id = tr.response_id
         )
   GROUP BY (date_trunc('day'::text, (tr.submitted_at AT TIME ZONE 'UTC'::text))::date), aa.audience
),
qual_bookings_d AS (
  SELECT b.booked_at AS date,
         b.audience,
         count(*) AS qualified_bookings
    FROM lib_strategy_booking_resolved b
   WHERE NOT b.is_dq AND NOT b.is_spam
   GROUP BY b.booked_at, b.audience
),
live_d AS (
  SELECT cca.report_date AS date,
         cca.audience,
         count(*) AS live_calls
    FROM lib_closer_call_audience cca
   WHERE cca.is_confirmed
     AND cca.call_type::text = 'new_call'::text
     AND (cca.outcome::text = ANY (ARRAY['closed'::character varying, 'not_closed'::character varying]::text[]))
     AND NOT EXISTS (SELECT 1 FROM closer_call_excluded e WHERE e.closer_call_id = cca.closer_call_id)
   GROUP BY cca.report_date, cca.audience
),
showrate_d AS (
  -- Audience-aware no_shows / reschedules / cancels.
  -- NC only (matches the show-rate denominator which is qualified_bookings).
  SELECT cca.report_date AS date,
         cca.audience,
         count(*) FILTER (WHERE cca.outcome::text = 'no_show'::text)     AS no_shows,
         count(*) FILTER (WHERE cca.outcome::text = 'rescheduled'::text) AS reschedules,
         count(*) FILTER (WHERE cca.outcome::text = 'canceled'::text)    AS cancels
    FROM lib_closer_call_audience cca
   WHERE cca.is_confirmed
     AND cca.call_type::text = 'new_call'::text
     AND NOT EXISTS (SELECT 1 FROM closer_call_excluded e WHERE e.closer_call_id = cca.closer_call_id)
   GROUP BY cca.report_date, cca.audience
),
ascensions_d AS (
  SELECT cca.report_date AS date,
         cca.audience,
         count(*)                                                AS ascensions,
         count(*) FILTER (WHERE cca.outcome::text = 'closed'::text) AS ascensions_closed
    FROM lib_closer_call_audience cca
   WHERE cca.is_confirmed
     AND cca.call_type::text = 'ascension'::text
     AND NOT EXISTS (SELECT 1 FROM closer_call_excluded e WHERE e.closer_call_id = cca.closer_call_id)
   GROUP BY cca.report_date, cca.audience
),
close_d AS (
  SELECT ca.created_at::date AS date,
         ca.audience,
         count(*)             AS closes,
         sum(ca.revenue)      AS revenue,
         sum(ca.cash_collected) AS cash
    FROM lib_close_audience ca
   WHERE ca.audience <> 'Referral'::text
   GROUP BY (ca.created_at::date), ca.audience
),
all_keys AS (
  SELECT date, audience FROM spend_d        UNION
  SELECT date, audience FROM leads_d        UNION
  SELECT date, audience FROM qual_bookings_d UNION
  SELECT date, audience FROM live_d         UNION
  SELECT date, audience FROM showrate_d     UNION
  SELECT date, audience FROM ascensions_d   UNION
  SELECT date, audience FROM close_d
)
SELECT k.date,
       k.audience,
       COALESCE(s.adspend, 0::numeric)        AS adspend,
       COALESCE(s.impressions, 0::bigint)     AS impressions,
       COALESCE(s.clicks, 0::bigint)          AS clicks,
       COALESCE(l.leads, 0::bigint)           AS leads,
       COALESCE(l.qualified_leads, 0::bigint) AS qualified_leads,
       COALESCE(q.qualified_bookings, 0::bigint) AS qualified_bookings,
       COALESCE(lv.live_calls, 0::bigint)     AS live_calls,
       COALESCE(c.closes, 0::bigint)          AS closes,
       COALESCE(c.revenue, 0::numeric)        AS trial_revenue,
       COALESCE(c.cash, 0::numeric)           AS trial_cash,
       COALESCE(asc1.ascensions, 0::bigint)   AS ascensions,
       COALESCE(asc1.ascensions_closed, 0::bigint) AS ascensions_closed,
       -- New audience-aware show-rate components:
       COALESCE(sr.no_shows, 0::bigint)       AS no_shows,
       COALESCE(sr.reschedules, 0::bigint)    AS reschedules,
       COALESCE(sr.cancels, 0::bigint)        AS cancels
  FROM all_keys k
  LEFT JOIN spend_d s         ON s.date = k.date  AND s.audience  = k.audience
  LEFT JOIN leads_d l         ON l.date = k.date  AND l.audience  = k.audience
  LEFT JOIN qual_bookings_d q ON q.date = k.date  AND q.audience  = k.audience
  LEFT JOIN live_d lv         ON lv.date = k.date AND lv.audience = k.audience
  LEFT JOIN showrate_d sr     ON sr.date = k.date AND sr.audience = k.audience
  LEFT JOIN ascensions_d asc1 ON asc1.date = k.date AND asc1.audience = k.audience
  LEFT JOIN close_d c         ON c.date = k.date  AND c.audience  = k.audience
 ORDER BY k.date DESC, k.audience;

GRANT SELECT ON lib_marketing_by_audience_daily TO authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- 4. Convenience view: surfacing detected spam patterns + duplicate clusters
--    in the leads stream so the UI can banner them.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS lib_lead_hygiene_flags CASCADE;
CREATE VIEW lib_lead_hygiene_flags AS
WITH base AS (
  SELECT tr.response_id,
         tr.submitted_at,
         tr.first_name || ' ' || tr.last_name AS name,
         tr.email,
         tr.phone,
         tr.form_name,
         aa.audience
    FROM typeform_responses tr
    LEFT JOIN lib_ad_audience aa ON aa.ad_id = tr.ad_id
   WHERE NOT EXISTS (SELECT 1 FROM lead_excluded le WHERE le.response_id = tr.response_id)
),
dupes AS (
  SELECT response_id,
         CASE WHEN count(*) OVER (PARTITION BY lower(email)) > 1 THEN 'duplicate_email'
              WHEN count(*) OVER (PARTITION BY phone) > 1        THEN 'duplicate_phone'
              ELSE NULL
         END AS dupe_flag
    FROM base
   WHERE email IS NOT NULL OR phone IS NOT NULL
),
spam AS (
  SELECT response_id,
         CASE
           WHEN email IS NULL OR email = '' THEN 'null_email'
           WHEN email ILIKE '%proton.me' OR email ILIKE '%protonmail%' THEN 'proton_pattern'
           WHEN email ILIKE '%mailinator%' OR email ILIKE '%tutamail%' OR email ILIKE '%10minute%' THEN 'throwaway'
           WHEN email ILIKE 'test@%' OR email ILIKE 'admin@%' OR email ILIKE 'noreply@%' THEN 'test_pattern'
           WHEN email ILIKE 'elonmusk%' OR email ILIKE 'donaldtrump%' OR email ILIKE 'mickeymouse%' THEN 'fake_celeb'
           ELSE NULL
         END AS spam_flag
    FROM base
)
SELECT b.response_id,
       b.submitted_at,
       b.name,
       b.email,
       b.phone,
       b.form_name,
       b.audience,
       d.dupe_flag,
       s.spam_flag,
       COALESCE(d.dupe_flag, s.spam_flag) AS any_flag
  FROM base b
  LEFT JOIN dupes d ON d.response_id = b.response_id
  LEFT JOIN spam  s ON s.response_id = b.response_id
 WHERE d.dupe_flag IS NOT NULL OR s.spam_flag IS NOT NULL;

GRANT SELECT ON lib_lead_hygiene_flags TO authenticated, anon, service_role;

NOTIFY pgrst, 'reload schema';
