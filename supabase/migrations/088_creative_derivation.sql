-- 088_creative_derivation.sql
--
-- Surface the Hook + Body source clips that compose each Joined (and
-- Full Video / Retargeting / Testimony) creative, so the UI can show:
--
--   Detail modal of a Hook  → "Used in N Joined composites: …"
--   Detail modal of a Body  → "Used in N Joined composites: …"
--   Detail modal of a Joined → "Made from: Hook X + Body Y"
--
-- Matching strategy is transcript-based (see client backfill in
-- AdsCreativeLibrary.jsx). For each Joined.transcript:
--   - find the Hook whose first ~15 words appear at the start
--   - find the Body whose first ~20 words appear anywhere in the body
-- IDs are written back here.
--
-- Operator can override the auto-match by editing these columns
-- manually (UI affordance shipped alongside).

BEGIN;

ALTER TABLE public.lib_creative_library
  ADD COLUMN IF NOT EXISTS derived_hook_id UUID REFERENCES public.lib_creative_library(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS derived_body_id UUID REFERENCES public.lib_creative_library(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS derivation_score NUMERIC,         -- 0..1, how confident the match is
  ADD COLUMN IF NOT EXISTS derivation_matched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_lib_creative_library_derived_hook_id
  ON public.lib_creative_library(derived_hook_id) WHERE derived_hook_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lib_creative_library_derived_body_id
  ON public.lib_creative_library(derived_body_id) WHERE derived_body_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
