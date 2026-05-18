-- ============================================================
-- LOCAL MIRROR OF GHL OPPORTUNITIES
-- Lets the marketing dashboard compute cohort-true L→Q% by
-- joining bookings to the lead's createdAt date.
--
-- Before: Leads tile counts opportunities createdAt in window,
-- Q.Book tile counts strategy bookings booked_at in window —
-- different cohorts, so Q.Book > Leads is mathematically valid
-- but indistinguishable from a counting bug to the user.
--
-- After: bookings bucket by their CONTACT's earliest opportunity
-- createdAt → Q.Book always ≤ Leads, L→Q% is a real conversion
-- rate (cohort: leads created in window, conversion: have any
-- strategy booking).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ghl_opportunities (
  id text PRIMARY KEY,                      -- GHL opportunity id
  ghl_contact_id text NOT NULL,
  pipeline_id text,
  stage_id text,
  name text,                                -- opportunity title
  status text,                              -- open / won / lost / abandoned
  source text,                              -- attribution source (when populated)
  created_at timestamptz NOT NULL,
  updated_at timestamptz,
  last_synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ghl_opportunities_contact_idx ON public.ghl_opportunities (ghl_contact_id);
CREATE INDEX IF NOT EXISTS ghl_opportunities_created_idx ON public.ghl_opportunities (created_at);
CREATE INDEX IF NOT EXISTS ghl_opportunities_pipeline_idx ON public.ghl_opportunities (pipeline_id);

ALTER TABLE public.ghl_opportunities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ghl_opportunities_read"  ON public.ghl_opportunities;
DROP POLICY IF EXISTS "ghl_opportunities_write" ON public.ghl_opportunities;

-- Read for any authenticated user (matches the rest of the sales dashboard).
DROP POLICY IF EXISTS "ghl_opportunities_read" ON public.ghl_opportunities;
CREATE POLICY "ghl_opportunities_read" ON public.ghl_opportunities
  FOR SELECT TO authenticated USING (true);

-- Anon read so the browser-side autoSync can upsert via service_role and the
-- dashboard can read via anon. Matches existing GHL table pattern.
DROP POLICY IF EXISTS "ghl_opportunities_anon_read" ON public.ghl_opportunities;
CREATE POLICY "ghl_opportunities_anon_read" ON public.ghl_opportunities
  FOR SELECT TO anon USING (true);

GRANT SELECT ON public.ghl_opportunities TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.ghl_opportunities TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
