-- ============================================================================
-- 168 · Index the columns lib_typeform_response_outcome actually probes
-- ============================================================================
--
-- SYMPTOM
--   SELECT from public.lib_typeform_response_outcome takes ~8.3s and
--   intermittently dies with 57014 "canceling statement due to statement
--   timeout". Measured 2026-08-24: 1 of 3 identical requests failed.
--   The Attribution Coverage page reads it through lib_attribution_* (mig
--   111) and through the three rollups in mig 036, so a timeout there takes
--   the page's outcome stages down with it.
--
-- CAUSE
--   The view (last redefined in mig 052) drives off typeform_responses and
--   probes two inner tables through LEFT JOIN LATERAL:
--
--     ghl_appointments  ON lower(a.contact_email) = lower(tfr.email)
--                       OR right(digits_only(a.contact_phone),10)
--                        = right(digits_only(tfr.phone),10)
--
--     closer_calls      ON c.prospect_name ILIKE (tfr.first_name || '%')
--                      AND c.prospect_name ILIKE ('%'||tfr.last_name||'%')
--
--   Mig 035 indexed lower(email) and phone on typeform_responses — but that
--   is the OUTER table, scanned once. The indexes that matter are on the
--   INNER tables, and none of those expressions had one. So every one of the
--   ~784 outer rows sequentially scanned all ~1,889 appointments, evaluating
--   regexp_replace() (via digits_only) on both sides of each comparison.
--   That is roughly 1.5M regex evaluations per query, which is the 8 seconds.
--
-- FIX
--   Expression indexes matching the join predicates exactly. digits_only is
--   declared IMMUTABLE PARALLEL SAFE in mig 035, so it is indexable as-is.
--
--   Deliberately NOT rewriting the view: mig 052 tightened the closer_calls
--   match on purpose (it was inflating closes) and that logic should not be
--   disturbed by a performance change. Indexes only.
--
-- SAFETY
--   Additive. No data is read, written or moved. Both tables are small
--   (1,889 and 565 rows) so the builds are effectively instant and taking a
--   brief ACCESS SHARE-blocking lock is not a concern at this size — hence
--   plain CREATE INDEX rather than CONCURRENTLY, which cannot run inside the
--   transaction Supabase wraps migrations in.
--   Rollback is DROP INDEX on the four names below.
-- ============================================================================

-- ── ghl_appointments: the email arm of the lateral ──────────────────────────
CREATE INDEX IF NOT EXISTS ix_appt_email_lower
  ON public.ghl_appointments (lower(contact_email))
  WHERE contact_email IS NOT NULL;

-- ── ghl_appointments: the phone arm, indexed on the exact expression ────────
CREATE INDEX IF NOT EXISTS ix_appt_phone_last10
  ON public.ghl_appointments (right(public.digits_only(contact_phone), 10))
  WHERE contact_phone IS NOT NULL;

-- ── ghl_appointments: the lateral's ORDER BY booked_at DESC tiebreak ────────
-- Mig 022 already indexes booked_at ascending; the lateral takes LIMIT 1 off
-- a DESC ordering, so give it a matching direction to read backwards cheaply.
CREATE INDEX IF NOT EXISTS ix_appt_booked_at_desc
  ON public.ghl_appointments (booked_at DESC NULLS LAST);

-- ── closer_calls: prospect_name is matched with a LEADING wildcard ──────────
-- ILIKE '%lastname%' cannot use a btree index at all. pg_trgm's GIN index is
-- the only thing that helps a leading-wildcard match.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS ix_closer_calls_prospect_trgm
  ON public.closer_calls USING gin (prospect_name gin_trgm_ops);

ANALYZE public.ghl_appointments;
ANALYZE public.closer_calls;

-- ── Verify after applying ───────────────────────────────────────────────────
-- EXPLAIN (ANALYZE, BUFFERS)
--   SELECT count(*) FROM public.lib_typeform_response_outcome;
--
-- Expect the Seq Scans on ghl_appointments / closer_calls inside the Nested
-- Loop to become Index Scans. If they do not, check that ANALYZE ran and
-- that the predicate in the view still matches these expressions character
-- for character — an expression index only applies to an exact match.
