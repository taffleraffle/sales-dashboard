-- Backfill booked_at for historical ghl_appointments rows.
--
-- Background: Migration 022 added the booked_at column, but existing rows
-- were inserted with booked_at = NULL (no DEFAULT was applied retroactively).
-- Marketing Tracker's auto_bookings metric filters `.gte('booked_at', since)`
-- which excludes every NULL row, so the trailing-period auto_bookings count
-- stays at 0 even though intro calls did get booked.
--
-- Best-effort backfill: when we don't know the booking moment, use
-- appointment_date (plus a conservative 09:00 UTC time) as a proxy. That's
-- better than NULL for the attribution query since it at least lands the
-- booking on a real date; for rows where booked_at was written correctly
-- (post migration-022 syncs), we leave the existing value alone.

UPDATE ghl_appointments
SET booked_at = (appointment_date::date + time '09:00') AT TIME ZONE 'UTC'
WHERE booked_at IS NULL
  AND appointment_date IS NOT NULL;

NOTIFY pgrst, 'reload schema';
