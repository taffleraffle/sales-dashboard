-- 031_messaging_ideations.sql
-- Persists each messaging ideation generation so the operator's work stays
-- forever — refresh, close tab, come back next week, the most recent runs
-- are still there. Auto-organised by recency, no manual filing required.
--
-- Apply via Supabase Studio SQL editor (idempotent).

BEGIN;

CREATE TABLE IF NOT EXISTS public.lib_messaging_ideations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The initial generation reply (problem/circumstance/outcome lenses)
  initial_reply   TEXT NOT NULL,
  -- Full conversation history including follow-ups, as
  -- [{ role: 'user' | 'assistant', content: string }]. The first entry is
  -- always the initial assistant reply (no user message preceded it because
  -- the initial generation has no inputs).
  conversation    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Metadata about the corpus that was used so we can show "40 calls + 50
  -- phrases" labels on history items
  transcript_count INT,
  phrase_count    INT,
  -- Optional user-supplied title; defaults to derived from first lens
  title           TEXT,
  -- Soft-delete so "stays forever" really means forever but operator can
  -- hide ones they don't want cluttering the picker
  archived_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lib_messaging_ideations_created
  ON public.lib_messaging_ideations(created_at DESC)
  WHERE archived_at IS NULL;

ALTER TABLE public.lib_messaging_ideations ENABLE ROW LEVEL SECURITY;

-- Internal tool, so we allow anon role to read/write — same posture as the
-- other lib_* tables in this app.
DROP POLICY IF EXISTS lib_ideations_select ON public.lib_messaging_ideations;
CREATE POLICY lib_ideations_select ON public.lib_messaging_ideations
  FOR SELECT USING (true);

DROP POLICY IF EXISTS lib_ideations_insert ON public.lib_messaging_ideations;
CREATE POLICY lib_ideations_insert ON public.lib_messaging_ideations
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS lib_ideations_update ON public.lib_messaging_ideations;
CREATE POLICY lib_ideations_update ON public.lib_messaging_ideations
  FOR UPDATE USING (true);

GRANT SELECT, INSERT, UPDATE ON public.lib_messaging_ideations TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
