-- 028_ad_library_v3.sql
-- Ad Library v3: messaging isolation + live gallery + analyst agent.
-- Stacks on top of:
--   • migration 011 (public.ads + public.ad_daily_stats)
--   • migration 012 (variant_id link + parser trigger + stats mirror)
--   • migration 027 (library schema: components, variants, performance_daily,
--                    materialized views)
--
-- Adds four things in `library` schema:
--   1. creative_transcripts — per-variant text we score against
--   2. phrase_performance   — nightly-computed phrase rankings
--   3. variant_states       — extends variants.status with the Andromeda-aware
--                              states (winning / foundational / bench / bad_pocket
--                              / fatigued) plus a derive function
--   4. agent_interpretations — auto-generated "what this means" callouts
--
-- All exposed to PostgREST via public-schema views matching the lib_* convention
-- from migration 027.
--
-- Apply by pasting into Supabase Studio SQL editor. Run once.

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1 · creative_transcripts
-- ─────────────────────────────────────────────────────────────────
-- One transcript per variant (preferred) OR per individual ad (fallback for
-- variants we haven't catalogued yet). Source enum captures provenance so we
-- can prefer Whisper over caption when both exist for the same variant.
CREATE TABLE IF NOT EXISTS library.creative_transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id UUID REFERENCES library.variants(id) ON DELETE CASCADE,
  ad_id TEXT REFERENCES public.ads(ad_id) ON DELETE CASCADE,
  meta_video_id TEXT,
  source TEXT NOT NULL CHECK (source IN (
    'ad_copy',         -- ad body + title pulled from Meta Graph API (always available)
    'meta_caption',    -- Meta auto-captions, when present
    'whisper_api',     -- OpenAI Whisper API on uploaded MP4
    'whisper_local',   -- Local Whisper.cpp run
    'manual'           -- Operator typed it in
  )),
  language TEXT DEFAULT 'en',
  full_text TEXT NOT NULL,
  segments JSONB DEFAULT '[]'::jsonb,
  duration_sec INT,
  confidence REAL,
  -- A variant can have multiple transcripts (one per source).
  -- Phrase scoring picks the best one in priority order.
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (variant_id, source),
  UNIQUE (ad_id, source)
);

CREATE INDEX IF NOT EXISTS idx_creative_transcripts_variant
  ON library.creative_transcripts(variant_id);

CREATE INDEX IF NOT EXISTS idx_creative_transcripts_ad
  ON library.creative_transcripts(ad_id);

CREATE INDEX IF NOT EXISTS idx_creative_transcripts_text_gin
  ON library.creative_transcripts USING gin (to_tsvector('english', full_text));

-- ─────────────────────────────────────────────────────────────────
-- 2 · phrase_performance
-- ─────────────────────────────────────────────────────────────────
-- Nightly job output. Each row = one phrase × one window × one brand × one
-- ngram size. Lookups go via (window, brand, ngram_size) sorted by perf score.
CREATE TABLE IF NOT EXISTS library.phrase_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phrase TEXT NOT NULL,
  ngram_size INT NOT NULL CHECK (ngram_size BETWEEN 1 AND 12),
  window_kind TEXT NOT NULL CHECK (window_kind IN ('full', 'hook', 'body')) DEFAULT 'full',
  brand TEXT,                              -- nullable = library-wide
  variants_count INT NOT NULL DEFAULT 0,
  total_spend NUMERIC(12, 2) NOT NULL DEFAULT 0,
  mean_perf_score REAL NOT NULL,
  delta_vs_library REAL NOT NULL,          -- mean_perf - library_mean_perf
  min_close_rate REAL,
  max_close_rate REAL,
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (phrase, window_kind, brand, ngram_size)
);

CREATE INDEX IF NOT EXISTS idx_phrase_perf_lookup
  ON library.phrase_performance(window_kind, brand, ngram_size, mean_perf_score DESC);

CREATE INDEX IF NOT EXISTS idx_phrase_perf_delta
  ON library.phrase_performance(window_kind, brand, delta_vs_library DESC);

-- ─────────────────────────────────────────────────────────────────
-- 3 · variant_states (extends library.variants.status enum)
-- ─────────────────────────────────────────────────────────────────
-- The Andromeda playbook (.kb/playbooks/jeremy-haynes-andromeda.md) requires
-- richer states than the original `concept | in_production | ready | retired`
-- enum from migration 027. We add the operational states that emerge from
-- daily perf + sales-team feedback:
--   winning      → 1-3 ads in an ad set getting all the reach + good-fit leads
--   foundational → scaling at-or-near ceiling within a foundational ad set
--   bench        → launched but didn't get reach, ready to redeploy
--   bad_pocket   → got reach but brought wrong-fit leads
--   fatigued     → was a winner, now CPA inflating + lead quality dropping
--
-- We drop the old CHECK constraint and use a TEXT field so this can flex
-- without future migrations. Validation moves to a CHECK list at the end.

-- Extend the variants.status CHECK list. We MERGE the existing 027 values
-- with the Andromeda-aware ones so existing rows (defaulting to 'planned')
-- survive the migration. ALTER TABLE … ADD CONSTRAINT validates existing
-- rows by default — if any row violates the new list, the whole transaction
-- rolls back. Merging is the safe path.
DO $$
BEGIN
  -- Drop the old check constraint if it exists (added in migration 027)
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'variants_status_check'
  ) THEN
    ALTER TABLE library.variants DROP CONSTRAINT variants_status_check;
  END IF;

  ALTER TABLE library.variants
    ADD CONSTRAINT variants_status_check
    CHECK (status IN (
      -- 027 legacy values (existing rows may have these — keep them valid)
      'planned', 'editing', 'ready', 'live', 'paused', 'killed', 'winner',
      -- v3 authoring states (alternate vocabulary)
      'concept', 'in_production', 'retired',
      -- v3 Andromeda-aware live states
      'winning', 'foundational', 'bench',
      'bad_pocket', 'fatigued'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Per-variant state metadata (when we last entered each state, why)
CREATE TABLE IF NOT EXISTS library.variant_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id UUID NOT NULL REFERENCES library.variants(id) ON DELETE CASCADE,
  prev_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT,                              -- e.g. "CPA inflated 32% over 7d"
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  computed_by TEXT DEFAULT 'auto'           -- 'auto' | 'manual'
);

CREATE INDEX IF NOT EXISTS idx_variant_state_history_variant
  ON library.variant_state_history(variant_id, computed_at DESC);

-- Hourly job: derive operational state from recent perf + sales-team feedback.
-- Implementation lives in src/services/variantStates.js for transparency &
-- iteration speed. This stub function is just a placeholder so the JS service
-- can call into it when we move logic server-side.
CREATE OR REPLACE FUNCTION library.note_variant_state(
  v_id UUID,
  new_state TEXT,
  reason TEXT
) RETURNS VOID AS $$
DECLARE
  current_status TEXT;
BEGIN
  SELECT status INTO current_status FROM library.variants WHERE id = v_id;

  IF current_status IS DISTINCT FROM new_state THEN
    UPDATE library.variants SET status = new_state WHERE id = v_id;
    INSERT INTO library.variant_state_history (variant_id, prev_status, new_status, reason)
    VALUES (v_id, current_status, new_state, reason);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────
-- 4 · agent_interpretations
-- ─────────────────────────────────────────────────────────────────
-- Auto-generated "what this means" callouts powering the editorial
-- .what-it-means blocks across pages. One row per (page_key, period) so a page
-- can query its own interpretation in O(1).
CREATE TABLE IF NOT EXISTS library.agent_interpretations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_key TEXT NOT NULL,                   -- e.g. 'ads_messaging.top_phrases', 'ads_gallery.headline'
  period_label TEXT NOT NULL,               -- 'last_7d', 'last_30d', 'mtd', 'custom_2026-04-15_2026-05-10'
  brand TEXT,
  body_md TEXT NOT NULL,                    -- markdown-formatted interpretation
  context_snapshot JSONB,                   -- the data the LLM was given, for audit
  model TEXT,                                -- claude-opus-4-7 / etc.
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (page_key, period_label, brand)
);

CREATE INDEX IF NOT EXISTS idx_agent_interp_lookup
  ON library.agent_interpretations(page_key, period_label, brand);

-- ─────────────────────────────────────────────────────────────────
-- 5 · Public-schema views (PostgREST exposure)
-- ─────────────────────────────────────────────────────────────────
-- Same convention as migration 027 (lib_components, lib_variants, etc.):
-- public views forwarding library.* tables so the frontend can read them via
-- supabase.from('lib_*').

CREATE OR REPLACE VIEW public.lib_creative_transcripts AS
  SELECT * FROM library.creative_transcripts;

CREATE OR REPLACE VIEW public.lib_phrase_performance AS
  SELECT * FROM library.phrase_performance;

CREATE OR REPLACE VIEW public.lib_variant_state_history AS
  SELECT * FROM library.variant_state_history;

CREATE OR REPLACE VIEW public.lib_agent_interpretations AS
  SELECT * FROM library.agent_interpretations;

-- Grants — read for authenticated, write for authenticated (RLS enforced below)
GRANT SELECT, INSERT, UPDATE, DELETE ON library.creative_transcripts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON library.phrase_performance TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON library.variant_state_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON library.agent_interpretations TO authenticated;

GRANT SELECT ON public.lib_creative_transcripts TO authenticated, anon;
GRANT SELECT ON public.lib_phrase_performance TO authenticated, anon;
GRANT SELECT ON public.lib_variant_state_history TO authenticated, anon;
GRANT SELECT ON public.lib_agent_interpretations TO authenticated, anon;

-- ─────────────────────────────────────────────────────────────────
-- 6 · RLS policies (match the lib_* pattern from migration 027)
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE library.creative_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE library.phrase_performance   ENABLE ROW LEVEL SECURITY;
ALTER TABLE library.variant_state_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE library.agent_interpretations ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read everything in the library; only admins write.
-- Mirrors the role-based pattern from migration 006.
DO $$
BEGIN
  -- creative_transcripts
  CREATE POLICY "creative_transcripts read auth" ON library.creative_transcripts
    FOR SELECT TO authenticated USING (true);
  CREATE POLICY "creative_transcripts write admin" ON library.creative_transcripts
    FOR ALL TO authenticated USING (
      EXISTS (SELECT 1 FROM public.team_members WHERE auth_user_id = auth.uid() AND role IN ('admin','closer'))
    ) WITH CHECK (
      EXISTS (SELECT 1 FROM public.team_members WHERE auth_user_id = auth.uid() AND role IN ('admin','closer'))
    );

  -- phrase_performance
  CREATE POLICY "phrase_performance read auth" ON library.phrase_performance
    FOR SELECT TO authenticated USING (true);
  CREATE POLICY "phrase_performance write admin" ON library.phrase_performance
    FOR ALL TO authenticated USING (
      EXISTS (SELECT 1 FROM public.team_members WHERE auth_user_id = auth.uid() AND role = 'admin')
    ) WITH CHECK (
      EXISTS (SELECT 1 FROM public.team_members WHERE auth_user_id = auth.uid() AND role = 'admin')
    );

  -- variant_state_history
  CREATE POLICY "variant_state_history read auth" ON library.variant_state_history
    FOR SELECT TO authenticated USING (true);
  CREATE POLICY "variant_state_history write admin" ON library.variant_state_history
    FOR ALL TO authenticated USING (
      EXISTS (SELECT 1 FROM public.team_members WHERE auth_user_id = auth.uid() AND role = 'admin')
    ) WITH CHECK (
      EXISTS (SELECT 1 FROM public.team_members WHERE auth_user_id = auth.uid() AND role = 'admin')
    );

  -- agent_interpretations
  CREATE POLICY "agent_interpretations read auth" ON library.agent_interpretations
    FOR SELECT TO authenticated USING (true);
  CREATE POLICY "agent_interpretations write admin" ON library.agent_interpretations
    FOR ALL TO authenticated USING (
      EXISTS (SELECT 1 FROM public.team_members WHERE auth_user_id = auth.uid() AND role = 'admin')
    ) WITH CHECK (
      EXISTS (SELECT 1 FROM public.team_members WHERE auth_user_id = auth.uid() AND role = 'admin')
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- 7 · Triggered updated_at
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION library.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS creative_transcripts_touch ON library.creative_transcripts;
CREATE TRIGGER creative_transcripts_touch
  BEFORE UPDATE ON library.creative_transcripts
  FOR EACH ROW EXECUTE FUNCTION library.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- 8 · Reload PostgREST schema cache
-- ─────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;

-- =============================================================================
-- Post-apply checks (run separately after COMMIT)
-- =============================================================================
-- SELECT 'creative_transcripts'  AS tbl, COUNT(*) FROM library.creative_transcripts
-- UNION ALL SELECT 'phrase_performance', COUNT(*) FROM library.phrase_performance
-- UNION ALL SELECT 'variant_state_history', COUNT(*) FROM library.variant_state_history
-- UNION ALL SELECT 'agent_interpretations', COUNT(*) FROM library.agent_interpretations;
--
-- -- Verify variant status enum accepts new states:
-- INSERT INTO library.variants (variant_id, hook_id, body_id, scene_id, creator_id, status)
-- VALUES ('TEST_BENCH_CHECK', NULL, NULL, NULL, NULL, 'bench');
-- DELETE FROM library.variants WHERE variant_id = 'TEST_BENCH_CHECK';
