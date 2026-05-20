-- 083_tradie_connect_and_version_cascade.sql
--
-- Two unrelated but small changes bundled:
--
-- 1. Seed the `opt-tradie-connect` offer (AU funnel covering Plumbers /
--    Electricians / Tradies / Roofers). The row was inserted into prod
--    out-of-band 2026-05-20; this migration captures it so future
--    rebuilds reproduce it.
--
-- 2. Add ON DELETE CASCADE FK for lib_creative_library.parent_id ->
--    lib_creative_library.id. Without this, hard-deleting a v1 row
--    leaves orphan v2/v3 rows pointing at a non-existent parent — the
--    VersionsPanel query then returns versions without a v1 entry and
--    `latestOnly` rollup misbehaves. CASCADE is the right UX here
--    (delete the root = delete all versions).
--
-- Both ops idempotent.

BEGIN;

-- 1. Tradie Connect offer (AU multi-trade funnel: plumbers, electricians,
--    roofers, general tradies). Matches the row already in prod 2026-05-20.
INSERT INTO public.offers (slug, name, vertical, mechanism_name, primary_audience, default_proof_characters, has_dual_guarantee)
VALUES
  ('opt-tradie-connect',
   'OPT Tradie Connect (AU)',
   'trades-au',
   NULL,
   'Australian trades — plumbers, electricians, roofers, general tradies — frustrated with lead-sharing platforms (hipages, Service Seeking, Oneflare) and chasing low-margin shared jobs',
   ARRAY[]::TEXT[],
   FALSE)
ON CONFLICT (slug) DO NOTHING;

-- 2. Versioning FK with CASCADE
-- Drop the constraint if it exists under any old name, then re-add with
-- the canonical name + CASCADE. Idempotent because we use a known name.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lib_creative_library_parent_id_fkey'
      AND conrelid = 'public.lib_creative_library'::regclass
  ) THEN
    ALTER TABLE public.lib_creative_library
      DROP CONSTRAINT lib_creative_library_parent_id_fkey;
  END IF;
END $$;

ALTER TABLE public.lib_creative_library
  ADD CONSTRAINT lib_creative_library_parent_id_fkey
  FOREIGN KEY (parent_id)
  REFERENCES public.lib_creative_library(id)
  ON DELETE CASCADE;

NOTIFY pgrst, 'reload schema';

COMMIT;
