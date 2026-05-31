-- 120_offer_proof_items.sql
-- Per-offer proof items (Ben 2026-06-01).
--
-- The offers.default_proof_characters column (TEXT[]) only ever stored
-- names. With migration 117's proof_type taxonomy we want offers to be
-- able to declare full structured proofs that apply across every script
-- generated for them — not just per-angle proofs.
--
-- New column offer_proof_items JSONB stores the per-offer roster. Each
-- entry has the same shape as a script_proof_characters row, minus the
-- angle_slug + active + display_order which only matter at the per-row
-- level:
--   { name, result_short, result_long?, industry_context?, metric_kind?,
--     proof_type, label? }
--
-- The Edge Function loads these alongside the angle's own proofs when
-- generating scripts. The combined roster gets the Schwartz rotation
-- directive applied to it.

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS offer_proof_items JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.offers.offer_proof_items IS
  'Per-offer structured proof roster. Shape: [{proof_type, name, result_short, result_long?, industry_context?, metric_kind?, label?}]. Loaded alongside per-angle proofs at script-gen time. Operator-edited via OfferConfigModal.';

NOTIFY pgrst, 'reload schema';
