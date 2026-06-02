-- Seed an "Accounting" offer/niche so it shows up in the creative library
-- offer dropdown alongside the existing OPT verticals (restoration, hvac,
-- electrical, roofing, white-label).
--
-- Anyone can add additional niches at runtime via the new "+ Add new niche"
-- affordance in the upload modal — this seed just covers the one Ben asked
-- for explicitly so it's there on first load.
--
-- Allow-all RLS on public.offers (set in migration 059) lets any
-- authenticated user INSERT new rows, which is what the add-niche UI
-- relies on. No new policy needed here.

BEGIN;

INSERT INTO public.offers (slug, name, vertical, mechanism_name, primary_audience, default_proof_characters, has_dual_guarantee)
VALUES
  ('opt-accounting',
   'OPT Accounting',
   'accounting',
   NULL,
   'Accountants / CPA firms — referral-driven (banker + attorney chains), not paying for shared leads',
   ARRAY[]::TEXT[],
   FALSE)
ON CONFLICT (slug) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
