-- Indexes for the lib_close_resolved view's hot path (Ben 2026-06-01:
-- "Resolved closes: canceling statement due to statement timeout").
--
-- lib_close_resolved's appt_chain CTE does:
--   FROM closed cd
--   JOIN ghl_appointments ap
--     ON ap.appointment_date BETWEEN (cd.created_at::date - '7 days')
--                                AND (cd.created_at::date + '2 days')
--    AND lower(ap.contact_name) ILIKE (cd.first_tok || '%')
--    AND ap.contact_email IS NOT NULL
--   JOIN typeform_responses t ON lower(t.email) = lower(ap.contact_email)
--
-- The existing (closer_id, appointment_date) composite isn't usable for the
-- closer_id-free date range scan above, so the planner falls back to a seq
-- scan of ghl_appointments per closer_call row → quadratic blowup → 60s
-- statement_timeout.
--
-- Indexes added (already applied to prod via Mgmt API):
--   idx_ghl_appointments_appointment_date     — fixes the date range scan
--   idx_ghl_appointments_contact_name_lower   — speeds the ILIKE prefix match
--   idx_ghl_appointments_contact_email_lower  — speeds the typeform JOIN
--   idx_closer_calls_created_at               — speeds the `closed` CTE filter
--
-- Post-fix timing (30d window, prod): lib_close_resolved 2.3s (was 60s+).

BEGIN;

CREATE INDEX IF NOT EXISTS idx_ghl_appointments_appointment_date
  ON public.ghl_appointments (appointment_date);

CREATE INDEX IF NOT EXISTS idx_ghl_appointments_contact_name_lower
  ON public.ghl_appointments (lower(contact_name));

CREATE INDEX IF NOT EXISTS idx_ghl_appointments_contact_email_lower
  ON public.ghl_appointments (lower(contact_email))
  WHERE contact_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_closer_calls_created_at
  ON public.closer_calls (created_at);

ANALYZE public.ghl_appointments;
ANALYZE public.closer_calls;

COMMIT;
