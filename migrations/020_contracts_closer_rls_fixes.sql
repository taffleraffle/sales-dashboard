-- 020_contracts_closer_rls_fixes.sql
-- Two RLS gaps that won't bite admin Ben but would silently break any
-- non-admin closer using the feature:
--
--   1. contract_amendments_update was admin-only, so closer hitting
--      "Lock in & regenerate" on their own thread would get 0 rows
--      affected with no error — silent failure. Closers need to be
--      able to set locked_at / final_clause_text on their own
--      amendments. They still can't tamper with admin-only fields
--      because the policy still scopes by closer_id.
--
--   2. Storage SELECT policy on contract-uploads only matched
--      agreement_pdf_path (the original upload). After regeneration
--      lands an amended-v{N}.pdf at amended_pdf_path, closers
--      couldn't re-open it via signed URL once the 10-min initial
--      URL expired.

-- ── contract_amendments: closers can lock their own threads ───────────────
DROP POLICY IF EXISTS contract_amendments_update ON public.contract_amendments;
CREATE POLICY contract_amendments_update ON public.contract_amendments
  FOR UPDATE TO authenticated
  USING (
    public.contracts_is_admin()
    OR closer_id = public.contracts_current_team_member()
    OR EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE c.id = contract_id
        AND c.closer_id = public.contracts_current_team_member()
    )
  )
  WITH CHECK (
    public.contracts_is_admin()
    OR closer_id = public.contracts_current_team_member()
    OR EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE c.id = contract_id
        AND c.closer_id = public.contracts_current_team_member()
    )
  );

-- ── Storage SELECT: closers can read amended PDFs on their contracts ─────
DROP POLICY IF EXISTS "contract-uploads select" ON storage.objects;
CREATE POLICY "contract-uploads select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'contract-uploads' AND (
      public.contracts_is_admin()
      OR owner = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.contracts c
        WHERE (c.agreement_pdf_path = name OR c.amended_pdf_path = name)
          AND c.closer_id = public.contracts_current_team_member()
      )
    )
  );

NOTIFY pgrst, 'reload schema';
