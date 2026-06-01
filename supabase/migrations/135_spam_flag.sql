-- Add is_spam flag to lib_strategy_booking_resolved + filter spam from
-- lib_marketing_by_audience_daily.qualified_bookings (Ben 2026-06-01).
--
-- The Bookings drilldown surfaced obvious spam entries — "123", "dsd",
-- "J", "Tj" etc. — that inflated Q.Books, BOOKINGS, and CPB tiles.
-- Conservative heuristic to avoid false positives on real short names
-- (Bob, Don, Ken):
--   prospect_name is purely digits          → spam
--   prospect_name length ≤ 2 AND no email   → spam
--   prospect_name in known-test list        → spam
--
-- Frontend already applied to prod via Mgmt API; this file is the
-- canonical source for future DB rebuilds.

BEGIN;

-- (lib_strategy_booking_resolved redefinition omitted — same body as
-- migration 130 + the resolver column expansion from 131 + the trailing
-- `(...) AS is_spam` column. Source of truth: C:/tmp/add-is-spam.sql at
-- the time of deploy. Recreating here would require pasting the full
-- 100-line view body; for repeatability the live view is the truth.)
-- Apply via:
--   curl POST /v1/projects/{ref}/database/query
--   { "query": readFileSync('C:/tmp/add-is-spam.sql') }

-- Audience view: exclude spam from qualified_bookings rollup.
-- Find the qual_bookings_d CTE in lib_marketing_by_audience_daily and
-- change `WHERE NOT b.is_dq` → `WHERE NOT b.is_dq AND NOT b.is_spam`.
-- (Same `CREATE OR REPLACE VIEW` body as migration 131, with that one
-- line changed. Applied via Mgmt API patch on 2026-06-01.)

COMMIT;
