-- 028a_minimal_debug.sql
-- Stripped-down version of 028 to isolate where the abort is happening.
-- Only creates the four tables. NO triggers, NO RLS, NO views, NO functions.
-- If this works, we know the abort was in the layered logic, not the DDL.
-- If this still fails, paste the EXACT error message back and I'll narrow further.

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- Table 1
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS library.creative_transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id UUID,
  ad_id TEXT,
  meta_video_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('ad_copy', 'meta_caption', 'whisper_api', 'whisper_local', 'manual')),
  language TEXT DEFAULT 'en',
  full_text TEXT NOT NULL,
  segments JSONB DEFAULT '[]'::jsonb,
  duration_sec INT,
  confidence REAL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────
-- Table 2
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS library.phrase_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phrase TEXT NOT NULL,
  ngram_size INT NOT NULL CHECK (ngram_size BETWEEN 1 AND 12),
  window_kind TEXT NOT NULL CHECK (window_kind IN ('full', 'hook', 'body')) DEFAULT 'full',
  brand TEXT,
  variants_count INT NOT NULL DEFAULT 0,
  total_spend NUMERIC(12, 2) NOT NULL DEFAULT 0,
  mean_perf_score REAL NOT NULL,
  delta_vs_library REAL NOT NULL,
  min_close_rate REAL,
  max_close_rate REAL,
  computed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────
-- Table 3
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS library.variant_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id UUID NOT NULL,
  prev_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT,
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  computed_by TEXT DEFAULT 'auto'
);

-- ─────────────────────────────────────────────────────────────────
-- Table 4
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS library.agent_interpretations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_key TEXT NOT NULL,
  period_label TEXT NOT NULL,
  brand TEXT,
  body_md TEXT NOT NULL,
  context_snapshot JSONB,
  model TEXT,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

NOTIFY pgrst, 'reload schema';

COMMIT;

-- After this commits, run this to verify all 4 exist:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'library'
-- AND table_name IN ('creative_transcripts','phrase_performance','variant_state_history','agent_interpretations');
