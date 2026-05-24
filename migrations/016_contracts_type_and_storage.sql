-- 016_contracts_type_and_storage.sql
-- Pivots the contracts feature from "create new contract" to "track existing
-- contract for amendment management." Two changes:
--
--   1. Add contract_type ('trial' | 'retainer') so the AI judge reasons
--      against the right clause structure. Trial = $997 / 14-day template
--      with auto-renewal + Payment Authority Clause 7.2. Retainer = $9K /
--      90-day template with Guarantee Clause 4 (DBA + photos + reviews).
--
--   2. Add agreement_pdf_path + create the `contract-uploads` storage
--      bucket so closers can drop the actual signed PDF when adding the
--      contract for tracking. Bucket is private; access via signed URLs
--      generated client-side.
--
-- Backfills: existing contracts (from phase 1 testing) default to 'trial'.

-- ── Schema changes ─────────────────────────────────────────────────────────
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS contract_type      text,
  ADD COLUMN IF NOT EXISTS agreement_pdf_path text;

-- Backfill any existing rows, then enforce NOT NULL
UPDATE public.contracts SET contract_type = 'trial' WHERE contract_type IS NULL;

ALTER TABLE public.contracts
  ALTER COLUMN contract_type SET NOT NULL,
  ADD CONSTRAINT contracts_contract_type_check
    CHECK (contract_type IN ('trial','retainer'));

-- ── Storage bucket ─────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'contract-uploads',
  'contract-uploads',
  false,                   -- private; access via signed URLs only
  20971520,                -- 20 MB ceiling per file
  ARRAY['application/pdf']::text[]
)
ON CONFLICT (id) DO UPDATE
SET file_size_limit    = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types,
    public             = EXCLUDED.public;

-- ── Storage RLS ────────────────────────────────────────────────────────────
-- Authenticated team members can upload + read PDFs in contract-uploads.
-- Admins can read everything; closers can read files they uploaded OR files
-- on contracts assigned to them. Service role bypasses RLS for the judge.
DROP POLICY IF EXISTS "contract-uploads insert" ON storage.objects;
CREATE POLICY "contract-uploads insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'contract-uploads');

DROP POLICY IF EXISTS "contract-uploads select" ON storage.objects;
CREATE POLICY "contract-uploads select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'contract-uploads' AND (
      public.contracts_is_admin()
      OR owner = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.contracts c
        WHERE c.agreement_pdf_path = name
          AND c.closer_id = public.contracts_current_team_member()
      )
    )
  );

DROP POLICY IF EXISTS "contract-uploads delete" ON storage.objects;
CREATE POLICY "contract-uploads delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'contract-uploads' AND (
      public.contracts_is_admin() OR owner = auth.uid()
    )
  );

NOTIFY pgrst, 'reload schema';
