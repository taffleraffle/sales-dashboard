-- Add booked_at column to ghl_appointments
--
-- Background: The sync code in src/services/ghlCalendar.js has been writing
-- `booked_at` (the timestamp at which the appointment was BOOKED, not the
-- time of the call itself) since it was introduced, but the original table
-- DDL (migration 003) never defined this column. PostgREST was silently
-- dropping the field from every upsert, and any read filtered on booked_at
-- returned zero rows. That broke both auto_bookings (which groups by
-- booked_at date) and downstream Marketing Tracker metrics.
--
-- This migration adds the column + an index + reloads the PostgREST schema
-- cache so the column is immediately usable via the Supabase client.

ALTER TABLE ghl_appointments
  ADD COLUMN IF NOT EXISTS booked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_ghl_appointments_booked_at
  ON ghl_appointments(booked_at);

-- Tell PostgREST to pick up the new column right away.
NOTIFY pgrst, 'reload schema';
