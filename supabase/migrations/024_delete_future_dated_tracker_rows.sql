-- Remove marketing_tracker rows with a future date.
--
-- Background: before the metaAdsSync fix that clamps to [since, today], the
-- qualified_bookings sync bucketed strategy calls by appointment_date — so
-- a call scheduled 8 days from now created a row dated 8 days from now in
-- marketing_tracker, with 0 spend / 0 leads / 0 live / 0 closes and a
-- non-zero qualified_bookings. Those rows polluted both the daily-tracker
-- display and the trailing-period rate columns (future-dated rows have
-- 0 live/0 closes, dragging Show% and Close% down).
--
-- This migration wipes future-dated rows so the historical data is clean.
-- The sync logic now prevents new ones from being created.
--
-- Safe to re-run: WHERE clause is idempotent (no rows match after first run
-- until another future-dated row somehow leaks in).

DELETE FROM marketing_tracker
WHERE date > CURRENT_DATE;

NOTIFY pgrst, 'reload schema';
