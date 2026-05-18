-- 070_test_batches.sql
--
-- Operator-defined test cycles. A test_batch is a draft of an upcoming
-- creative test — a named bundle of generated_scripts that haven't been
-- filmed/launched yet. Once the scripts are linked to real Meta ads,
-- the operator can mark the batch as "launched" and capture which
-- campaign(s) it became.
--
-- Workflow:
--   1. Operator creates a draft batch (name + hypothesis)
--   2. Generates scripts on /generate, saves them into the batch
--      OR moves existing draft scripts into the batch
--   3. Reviews batch density (hook mix, frame mix, pain mix) before
--      committing to film
--   4. Films + ships ads → links each script to its ad_id (existing flow)
--   5. Marks the batch as launched + records the campaign names

BEGIN;

CREATE TABLE IF NOT EXISTS public.test_batches (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  slug                  TEXT,  -- for URL display, auto-generated client-side
  hypothesis            TEXT,  -- "Test diagnostic vs conditional hook on TPA pain"
  notes                 TEXT,
  offer_slug            TEXT REFERENCES public.offers(slug),
  -- Launch lifecycle: created_at always set; launched_at NULL = draft
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  launched_at           TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,  -- when the operator declares the test complete
  -- Which Meta campaigns this batch became when launched (free-text since
  -- the schema doesn't have a campaigns table; we use campaign_name as the
  -- join key, same as everywhere else)
  campaign_names        TEXT[] DEFAULT '{}',
  -- Operator who created it (for multi-user later; nullable for now)
  created_by            TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_test_batches_created     ON public.test_batches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_batches_launched    ON public.test_batches(launched_at)
  WHERE launched_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_test_batches_offer       ON public.test_batches(offer_slug);

-- Link generated_scripts to a batch. NULL = unassigned (loose drafts that
-- don't belong to any test yet).
ALTER TABLE public.generated_scripts
  ADD COLUMN IF NOT EXISTS test_batch_id UUID REFERENCES public.test_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_generated_scripts_test_batch
  ON public.generated_scripts(test_batch_id) WHERE test_batch_id IS NOT NULL;

-- updated_at trigger (mirrors the pattern used elsewhere)
CREATE OR REPLACE FUNCTION public.touch_test_batches_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_test_batches_updated_at ON public.test_batches;
CREATE TRIGGER trg_test_batches_updated_at
  BEFORE UPDATE ON public.test_batches
  FOR EACH ROW EXECUTE FUNCTION public.touch_test_batches_updated_at();

-- RLS — same allow-all-authenticated pattern as creative_attributes.
-- The dashboard is internal-only; we'd tighten this once we have RBAC.
ALTER TABLE public.test_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "test_batches: read all"   ON public.test_batches;
DROP POLICY IF EXISTS "test_batches: write auth" ON public.test_batches;
CREATE POLICY "test_batches: read all"   ON public.test_batches FOR SELECT USING (true);
CREATE POLICY "test_batches: write auth" ON public.test_batches FOR ALL USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.test_batches TO authenticated, anon;

-- A convenience view: batch + script-density rollup (one row per batch
-- with JSON aggregates for hook/frame/mech/pain distributions). Lets the
-- Drafts cards render without N+1 queries from the client.
CREATE OR REPLACE VIEW public.lib_test_batch_density AS
SELECT
  b.id,
  b.name,
  b.slug,
  b.hypothesis,
  b.notes,
  b.offer_slug,
  b.created_at,
  b.launched_at,
  b.closed_at,
  b.campaign_names,
  b.created_by,
  b.updated_at,
  COUNT(s.id) AS script_count,
  COUNT(s.ad_id) FILTER (WHERE s.ad_id IS NOT NULL) AS linked_count,
  -- Per-attribute density as JSONB: { "diagnostic": 5, "conditional": 3, ... }
  COALESCE(jsonb_object_agg(s.target_attributes->>'hook_type',         hcount.n) FILTER (WHERE hcount.n IS NOT NULL),        '{}'::jsonb) AS hook_density,
  COALESCE(jsonb_object_agg(s.target_attributes->>'message_frame',     fcount.n) FILTER (WHERE fcount.n IS NOT NULL),        '{}'::jsonb) AS frame_density,
  COALESCE(jsonb_object_agg(s.target_attributes->>'mechanism_reveal',  mcount.n) FILTER (WHERE mcount.n IS NOT NULL),        '{}'::jsonb) AS mech_density,
  COALESCE(jsonb_object_agg(s.target_attributes->>'pain_angle',        pcount.n) FILTER (WHERE pcount.n IS NOT NULL),        '{}'::jsonb) AS pain_density,
  COALESCE(jsonb_object_agg(s.target_attributes->>'proof_character',   ppcount.n) FILTER (WHERE ppcount.n IS NOT NULL),      '{}'::jsonb) AS proof_density
FROM public.test_batches b
LEFT JOIN public.generated_scripts s ON s.test_batch_id = b.id
-- Compute per-value counts in subqueries to feed jsonb_object_agg
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS n
  FROM public.generated_scripts s2
  WHERE s2.test_batch_id = b.id
    AND s2.target_attributes->>'hook_type' = s.target_attributes->>'hook_type'
) hcount ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS n
  FROM public.generated_scripts s2
  WHERE s2.test_batch_id = b.id
    AND s2.target_attributes->>'message_frame' = s.target_attributes->>'message_frame'
) fcount ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS n
  FROM public.generated_scripts s2
  WHERE s2.test_batch_id = b.id
    AND s2.target_attributes->>'mechanism_reveal' = s.target_attributes->>'mechanism_reveal'
) mcount ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS n
  FROM public.generated_scripts s2
  WHERE s2.test_batch_id = b.id
    AND s2.target_attributes->>'pain_angle' = s.target_attributes->>'pain_angle'
) pcount ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS n
  FROM public.generated_scripts s2
  WHERE s2.test_batch_id = b.id
    AND s2.target_attributes->>'proof_character' = s.target_attributes->>'proof_character'
) ppcount ON true
GROUP BY b.id;

GRANT SELECT ON public.lib_test_batch_density TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
