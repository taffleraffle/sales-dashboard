-- ============================================================
-- DUPLICATE PROSPECT RESOLUTIONS
-- Lets Ben click a duplicate pair in the marketing dashboard banner
-- and either confirm "same person" (merge — secondary contact_id stops
-- counting separately in bookings/lives/closes) or "different people"
-- (dismiss — pair drops off the duplicate list forever).
--
-- Schema is symmetric — we always store the pair in a canonical
-- order (lexicographically smaller contact_id as `primary_contact_id`).
-- That way (A,B) and (B,A) resolve to the same row.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.prospect_dupe_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_contact_id text NOT NULL,
  secondary_contact_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('merge', 'not_duplicate')),
  resolved_by text,
  notes text,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (primary_contact_id, secondary_contact_id),
  CHECK (primary_contact_id < secondary_contact_id)
);

CREATE INDEX IF NOT EXISTS prospect_dupe_resolutions_primary_idx
  ON public.prospect_dupe_resolutions (primary_contact_id);
CREATE INDEX IF NOT EXISTS prospect_dupe_resolutions_secondary_idx
  ON public.prospect_dupe_resolutions (secondary_contact_id);

ALTER TABLE public.prospect_dupe_resolutions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dupe_resolutions_read"      ON public.prospect_dupe_resolutions;
DROP POLICY IF EXISTS "dupe_resolutions_anon_read" ON public.prospect_dupe_resolutions;
DROP POLICY IF EXISTS "dupe_resolutions_write"     ON public.prospect_dupe_resolutions;

CREATE POLICY "dupe_resolutions_read" ON public.prospect_dupe_resolutions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "dupe_resolutions_anon_read" ON public.prospect_dupe_resolutions
  FOR SELECT TO anon USING (true);
CREATE POLICY "dupe_resolutions_write" ON public.prospect_dupe_resolutions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT ON public.prospect_dupe_resolutions TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.prospect_dupe_resolutions TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
