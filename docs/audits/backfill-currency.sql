-- ============================================================================
-- Currency backfill — NOT a migration. Nothing runs this automatically.
-- Drafted 2026-08-24. REQUIRES Will's explicit go-ahead before it is run.
-- ============================================================================
--
-- WHY
--   Until the fix in `fix/one-currency-one-place`, two sync paths wrote the
--   same columns in different currencies:
--
--     src/services/metaAdsSync.js   (browser)  ->  multiplied by ~0.56, USD
--     supabase/functions/sync-meta-ads-full    ->  raw, NZD
--
--   Display code then multiplied by the rate again. So marketing_daily and
--   marketing_tracker.adspend were double-converted on screen and read ~44%
--   low, which flattered every CPL / CPA / ROAS on the Marketing page.
--
--   Going forward every writer stores raw NZD. Historical rows are still
--   mixed and this script normalises them.
--
-- SCOPE (measured against ad_daily_stats, 242 overlapping days with spend)
--   102 days  marketing_daily == ad_daily_stats     -> already NZD, leave alone
--   138 days  ratio ~1.7857 (1 / 0.56)              -> stored USD, needs /0.56
--     2 days  2026-03-07 (1.500), 2026-08-23 (1.698) -> MIXED, both syncs ran.
--             Do these by hand or re-pull them from Meta. Do not bulk-convert.
--
--   Affected window: 2026-02-11 .. 2026-08-22.
--
-- BEFORE RUNNING
--   1. Snapshot:  CREATE TABLE marketing_daily_bak_20260824 AS
--                   SELECT * FROM marketing_daily;
--                 CREATE TABLE marketing_tracker_bak_20260824 AS
--                   SELECT * FROM marketing_tracker;
--   2. Run the VERIFY block below and eyeball the day count.
--   3. Run one day first, check the Marketing page, then run the rest.
--
--   The rate below is the one that was actually baked into the historical
--   rows (the old hardcoded fallback), NOT today's live rate. Do not
--   "helpfully" update it — it is the number that must be divided back out.
-- ============================================================================

\set rate 0.56

-- ── VERIFY: which days would change, and by how much ────────────────────────
WITH ads AS (
  SELECT date, sum(spend) AS nzd FROM ad_daily_stats GROUP BY date
), md AS (
  SELECT date, sum(spend) AS stored FROM marketing_daily GROUP BY date
)
SELECT md.date,
       round(md.stored::numeric, 2)          AS stored_now,
       round(ads.nzd::numeric, 2)            AS nzd_truth,
       round((ads.nzd / md.stored)::numeric, 4) AS ratio,
       CASE
         WHEN abs(ads.nzd / md.stored - 1) < 0.02      THEN 'already NZD - skip'
         WHEN ads.nzd / md.stored BETWEEN 1.7 AND 1.9  THEN 'USD - convert'
         ELSE                                               'MIXED - by hand'
       END AS verdict
FROM md JOIN ads USING (date)
WHERE md.stored > 50 AND ads.nzd > 50
ORDER BY md.date;

-- ── APPLY: only the unambiguous USD days ────────────────────────────────────
-- Guarded on the ratio so a re-run is a no-op: once a day is converted its
-- ratio becomes ~1.0 and it no longer matches.
BEGIN;

WITH ads AS (
  SELECT date, sum(spend) AS nzd FROM ad_daily_stats GROUP BY date
), md AS (
  SELECT date, sum(spend) AS stored FROM marketing_daily GROUP BY date
), targets AS (
  SELECT md.date
  FROM md JOIN ads USING (date)
  WHERE md.stored > 0
    AND ads.nzd / md.stored BETWEEN 1.7 AND 1.9
    AND md.date BETWEEN DATE '2026-02-11' AND DATE '2026-08-22'
    AND md.date NOT IN (DATE '2026-03-07', DATE '2026-08-23')
)
UPDATE marketing_daily m
   SET spend = m.spend / :rate,
       cpc   = CASE WHEN m.cpc IS NOT NULL THEN m.cpc / :rate END,
       cpl   = CASE WHEN m.cpl IS NOT NULL THEN m.cpl / :rate END
  FROM targets t
 WHERE m.date = t.date;

-- marketing_tracker.adspend is copied from marketing_daily by metaAdsSync
-- step 7, so re-derive it rather than scaling it independently.
UPDATE marketing_tracker mt
   SET adspend    = agg.nzd,
       updated_at = now()
  FROM (SELECT date, sum(spend) AS nzd FROM marketing_daily GROUP BY date) agg
 WHERE mt.date = agg.date
   AND mt.date BETWEEN DATE '2026-02-11' AND DATE '2026-08-22'
   AND mt.adspend IS DISTINCT FROM agg.nzd;

-- Inspect the row counts this reports, THEN commit.
-- ROLLBACK;
COMMIT;

-- ── AFTER ───────────────────────────────────────────────────────────────────
-- Re-run the VERIFY block. Every day in the window should now read
-- 'already NZD - skip' apart from the two MIXED days.
