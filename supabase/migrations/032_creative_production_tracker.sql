-- 032_creative_production_tracker.sql
-- Adds the atomic-clip catalog + extends library.variants with production
-- tracking columns, replacing the Google Sheet workflow.
--
-- Shape:
--   library.clips           — atomic editable clip files (H1.1-OSO,
--                              P-ADAM-OSO, BODY-B1-OSO, etc). One row per
--                              physical edit task that Mohamed cuts ONCE.
--   library.variants        — already exists. We add the production-stage
--                              booleans (raw → rough → final → approved →
--                              uploaded) plus references to the atomic clips
--                              this variant splices together.
--   public.lib_variants_with_performance — convenience view that joins each
--                              variant to its linked Meta ad's spend (30d) +
--                              HYROS calls/revenue so the variants page can
--                              sort performance-first.

BEGIN;

-- ─── 1. library.clips — atomic clip catalog ──────────────────────────
CREATE TABLE IF NOT EXISTS library.clips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_id         TEXT NOT NULL UNIQUE,
  clip_type       TEXT NOT NULL,
  section         TEXT,
  description     TEXT,
  creator_id      TEXT,
  editor          TEXT,
  priority        TEXT,
  duration_sec    INTEGER,
  source_file_url TEXT,
  source_file_name TEXT,
  stage_raw       BOOLEAN NOT NULL DEFAULT FALSE,
  stage_rough_cut BOOLEAN NOT NULL DEFAULT FALSE,
  stage_final_cut BOOLEAN NOT NULL DEFAULT FALSE,
  stage_approved  BOOLEAN NOT NULL DEFAULT FALSE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clips_type    ON library.clips(clip_type);
CREATE INDEX IF NOT EXISTS idx_clips_creator ON library.clips(creator_id);
CREATE INDEX IF NOT EXISTS idx_clips_section ON library.clips(section);

-- Touch updated_at on UPDATE
CREATE OR REPLACE FUNCTION library.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_clips_touch ON library.clips;
CREATE TRIGGER trg_clips_touch BEFORE UPDATE ON library.clips
  FOR EACH ROW EXECUTE FUNCTION library.touch_updated_at();

-- ─── 2. Extend library.variants with production tracking ─────────────
ALTER TABLE library.variants
  ADD COLUMN IF NOT EXISTS hook_clip_id    TEXT,
  ADD COLUMN IF NOT EXISTS body_clip_id    TEXT,
  ADD COLUMN IF NOT EXISTS frame_clip_id   TEXT,
  ADD COLUMN IF NOT EXISTS editor          TEXT,
  ADD COLUMN IF NOT EXISTS priority        TEXT,
  ADD COLUMN IF NOT EXISTS stage_raw       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stage_rough_cut BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stage_final_cut BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stage_approved  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stage_uploaded  BOOLEAN NOT NULL DEFAULT FALSE;

-- Soft FKs to clips so existing variant rows don't break if a clip is deleted
ALTER TABLE library.variants
  DROP CONSTRAINT IF EXISTS variants_hook_clip_id_fkey;
ALTER TABLE library.variants
  ADD CONSTRAINT variants_hook_clip_id_fkey FOREIGN KEY (hook_clip_id)
  REFERENCES library.clips(clip_id) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE library.variants
  DROP CONSTRAINT IF EXISTS variants_body_clip_id_fkey;
ALTER TABLE library.variants
  ADD CONSTRAINT variants_body_clip_id_fkey FOREIGN KEY (body_clip_id)
  REFERENCES library.clips(clip_id) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE library.variants
  DROP CONSTRAINT IF EXISTS variants_frame_clip_id_fkey;
ALTER TABLE library.variants
  ADD CONSTRAINT variants_frame_clip_id_fkey FOREIGN KEY (frame_clip_id)
  REFERENCES library.clips(clip_id) ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 3. PostgREST-exposed mirror views (lib_clips, lib_variants_with_performance) ───
-- The PostgREST role can only see public schema. We expose library tables
-- via SELECT-only views, and route writes through SECURITY DEFINER RPCs.

CREATE OR REPLACE VIEW public.lib_clips AS SELECT * FROM library.clips;

-- Convenience view: variant + linked-ad spend (30d) + HYROS attribution.
-- Joins through ads → ad_daily_stats and lib_hyros_ad_attribution so the
-- variants page can answer "which variants are LIVE and performing" in
-- a single query.
CREATE OR REPLACE VIEW public.lib_variants_with_performance AS
SELECT
  v.id,
  v.variant_id,
  v.status,
  v.iteration,
  v.notes,
  v.editor,
  v.priority,
  v.hook_id,
  v.body_angle_id,
  v.scene_id,
  v.creator_id,
  v.hook_clip_id,
  v.body_clip_id,
  v.frame_clip_id,
  v.meta_ad_id,
  v.meta_ad_name,
  v.asset_url,
  v.stage_raw,
  v.stage_rough_cut,
  v.stage_final_cut,
  v.stage_approved,
  v.stage_uploaded,
  v.created_at,
  v.updated_at,
  v.launched_at,
  a.thumbnail_url AS ad_thumbnail_url,
  a.asset_url AS ad_asset_url,
  a.effective_status AS ad_effective_status,
  a.campaign_name,
  a.adset_name,
  COALESCE((
    SELECT SUM(s.spend::numeric)
    FROM public.ad_daily_stats s
    WHERE s.ad_id = v.meta_ad_id AND s.date >= CURRENT_DATE - 30
  ), 0) AS spend_30d,
  COALESCE((
    SELECT SUM(s.results)
    FROM public.ad_daily_stats s
    WHERE s.ad_id = v.meta_ad_id AND s.date >= CURRENT_DATE - 30
  ), 0) AS results_30d,
  hy.calls_attributed AS hyros_calls,
  hy.calls_qualified  AS hyros_qualified,
  hy.revenue_attributed AS hyros_revenue
FROM library.variants v
LEFT JOIN public.ads a ON a.ad_id = v.meta_ad_id
LEFT JOIN public.lib_hyros_ad_attribution hy ON hy.ad_id = v.meta_ad_id;

-- ─── 4. RPCs for clip + variant writes (SECURITY DEFINER) ────────────
-- PostgREST can't INSERT into a view, so we expose write paths as RPCs
-- backed by the SECURITY DEFINER pattern that already works elsewhere in
-- this app (see link_ad_to_variant in migration 012).

CREATE OR REPLACE FUNCTION public.lib_clip_upsert(
  p_clip_id          TEXT,
  p_clip_type        TEXT,
  p_section          TEXT DEFAULT NULL,
  p_description      TEXT DEFAULT NULL,
  p_creator_id       TEXT DEFAULT NULL,
  p_editor           TEXT DEFAULT NULL,
  p_priority         TEXT DEFAULT NULL,
  p_duration_sec     INTEGER DEFAULT NULL,
  p_source_file_url  TEXT DEFAULT NULL,
  p_source_file_name TEXT DEFAULT NULL,
  p_notes            TEXT DEFAULT NULL
) RETURNS library.clips
LANGUAGE plpgsql SECURITY DEFINER SET search_path = library, public
AS $$
DECLARE
  out_row library.clips;
BEGIN
  INSERT INTO library.clips (
    clip_id, clip_type, section, description, creator_id, editor, priority,
    duration_sec, source_file_url, source_file_name, notes
  ) VALUES (
    p_clip_id, p_clip_type, p_section, p_description, p_creator_id, p_editor,
    p_priority, p_duration_sec, p_source_file_url, p_source_file_name, p_notes
  )
  ON CONFLICT (clip_id) DO UPDATE SET
    clip_type        = EXCLUDED.clip_type,
    section          = EXCLUDED.section,
    description      = EXCLUDED.description,
    creator_id       = EXCLUDED.creator_id,
    editor           = EXCLUDED.editor,
    priority         = EXCLUDED.priority,
    duration_sec     = EXCLUDED.duration_sec,
    source_file_url  = EXCLUDED.source_file_url,
    source_file_name = EXCLUDED.source_file_name,
    notes            = EXCLUDED.notes,
    updated_at       = NOW()
  RETURNING * INTO out_row;
  RETURN out_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.lib_clip_set_stage(
  p_clip_id  TEXT,
  p_stage    TEXT,     -- raw | rough_cut | final_cut | approved
  p_value    BOOLEAN
) RETURNS library.clips
LANGUAGE plpgsql SECURITY DEFINER SET search_path = library, public
AS $$
DECLARE
  out_row library.clips;
BEGIN
  IF p_stage NOT IN ('raw','rough_cut','final_cut','approved') THEN
    RAISE EXCEPTION 'invalid stage: %', p_stage;
  END IF;

  EXECUTE format(
    'UPDATE library.clips SET stage_%I = $1, updated_at = NOW() WHERE clip_id = $2 RETURNING *',
    p_stage
  ) INTO out_row USING p_value, p_clip_id;
  RETURN out_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.lib_clip_delete(p_clip_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = library, public
AS $$
BEGIN
  DELETE FROM library.clips WHERE clip_id = p_clip_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.lib_variant_set_stage(
  p_variant_id TEXT,
  p_stage      TEXT,    -- raw | rough_cut | final_cut | approved | uploaded
  p_value      BOOLEAN
) RETURNS library.variants
LANGUAGE plpgsql SECURITY DEFINER SET search_path = library, public
AS $$
DECLARE
  out_row library.variants;
BEGIN
  IF p_stage NOT IN ('raw','rough_cut','final_cut','approved','uploaded') THEN
    RAISE EXCEPTION 'invalid stage: %', p_stage;
  END IF;

  EXECUTE format(
    'UPDATE library.variants SET stage_%I = $1, updated_at = NOW() WHERE variant_id = $2 RETURNING *',
    p_stage
  ) INTO out_row USING p_value, p_variant_id;
  RETURN out_row;
END;
$$;

-- ─── 5. Grants ───────────────────────────────────────────────────────
GRANT SELECT ON public.lib_clips                       TO anon, authenticated;
GRANT SELECT ON public.lib_variants_with_performance   TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.lib_clip_upsert       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lib_clip_set_stage    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lib_clip_delete       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lib_variant_set_stage TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
