-- 019_contracts_amended_pdf.sql
-- Adds amended_pdf_path so contracts can point at the latest regenerated
-- PDF (base agreement + amendment addendum pages) produced by the
-- regenerate-amended-agreement Edge Function. Old agreement_pdf_path stays
-- as the original (pre-amendment) reference upload.

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS amended_pdf_path text;

NOTIFY pgrst, 'reload schema';
