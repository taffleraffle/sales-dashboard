-- Bridge `library.*` tables into the `public` schema so PostgREST can read
-- and the dashboard doesn't need the library schema exposed in Supabase
-- Settings > API. Adds:
--   1. SECURITY DEFINER views in public for every library table (read).
--   2. RPCs in public for upsert + archive on components and variants (write).
--   3. Public Storage bucket `creative_components` for asset uploads, with
--      RLS that keys access on the authenticated role.
--
-- After this migration runs, the dashboard reads from public.lib_* and
-- writes via public.lib_upsert_component / lib_upsert_variant. No further
-- Supabase Studio configuration required.

-- ── 1. Public views over library tables ────────────────────────────────────
DROP VIEW IF EXISTS public.lib_components CASCADE;
CREATE VIEW public.lib_components
WITH (security_invoker = on) AS
SELECT * FROM library.components;

DROP VIEW IF EXISTS public.lib_variants CASCADE;
CREATE VIEW public.lib_variants
WITH (security_invoker = on) AS
SELECT * FROM library.variants;

DROP VIEW IF EXISTS public.lib_performance_daily CASCADE;
CREATE VIEW public.lib_performance_daily
WITH (security_invoker = on) AS
SELECT * FROM library.performance_daily;

DROP VIEW IF EXISTS public.lib_legacy_ad_mapping CASCADE;
CREATE VIEW public.lib_legacy_ad_mapping
WITH (security_invoker = on) AS
SELECT * FROM library.legacy_ad_mapping;

DROP VIEW IF EXISTS public.lib_orphan_ads CASCADE;
CREATE VIEW public.lib_orphan_ads
WITH (security_invoker = on) AS
SELECT * FROM library.orphan_ads;

DROP VIEW IF EXISTS public.lib_component_performance CASCADE;
CREATE VIEW public.lib_component_performance
WITH (security_invoker = on) AS
SELECT * FROM library.component_performance;

DROP VIEW IF EXISTS public.lib_cohort_hook_body CASCADE;
CREATE VIEW public.lib_cohort_hook_body
WITH (security_invoker = on) AS
SELECT * FROM library.cohort_hook_body;

GRANT SELECT ON public.lib_components TO authenticated, anon, service_role;
GRANT SELECT ON public.lib_variants TO authenticated, anon, service_role;
GRANT SELECT ON public.lib_performance_daily TO authenticated, anon, service_role;
GRANT SELECT ON public.lib_legacy_ad_mapping TO authenticated, anon, service_role;
GRANT SELECT ON public.lib_orphan_ads TO authenticated, anon, service_role;
GRANT SELECT ON public.lib_component_performance TO authenticated, anon, service_role;
GRANT SELECT ON public.lib_cohort_hook_body TO authenticated, anon, service_role;

-- ── 2. Authoring RPCs (write path through public) ──────────────────────────
--
-- Views can't be inserted into through PostgREST without INSTEAD OF triggers
-- or rules. RPCs are simpler and let us validate input.

CREATE OR REPLACE FUNCTION public.lib_upsert_component(
  p_component_id  TEXT,
  p_type          TEXT,
  p_label         TEXT,
  p_description   TEXT DEFAULT NULL,
  p_script_text   TEXT DEFAULT NULL,
  p_duration_sec  INT DEFAULT NULL,
  p_asset_url     TEXT DEFAULT NULL,
  p_status        TEXT DEFAULT 'concept'
)
RETURNS public.lib_components
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, library
AS $$
DECLARE
  result_row public.lib_components;
BEGIN
  IF p_type NOT IN ('hook', 'body_angle', 'scene', 'creator') THEN
    RAISE EXCEPTION 'Invalid component type: %. Must be hook, body_angle, scene, or creator.', p_type;
  END IF;
  IF p_status NOT IN ('concept', 'in_production', 'ready', 'retired') THEN
    RAISE EXCEPTION 'Invalid status: %. Must be concept, in_production, ready, or retired.', p_status;
  END IF;

  INSERT INTO library.components
    (component_id, type, label, description, script_text, duration_sec, asset_url, status)
  VALUES
    (p_component_id, p_type, p_label, p_description, p_script_text, p_duration_sec, p_asset_url, p_status)
  ON CONFLICT (component_id) DO UPDATE SET
    label        = EXCLUDED.label,
    description  = EXCLUDED.description,
    script_text  = EXCLUDED.script_text,
    duration_sec = EXCLUDED.duration_sec,
    asset_url    = EXCLUDED.asset_url,
    status       = EXCLUDED.status,
    updated_at   = NOW();

  SELECT * INTO result_row FROM library.components WHERE component_id = p_component_id;
  RETURN result_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lib_upsert_component(TEXT, TEXT, TEXT, TEXT, TEXT, INT, TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.lib_archive_component(p_component_id TEXT)
RETURNS public.lib_components
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, library
AS $$
DECLARE result_row public.lib_components;
BEGIN
  UPDATE library.components
     SET status = 'retired', updated_at = NOW()
   WHERE component_id = p_component_id;
  SELECT * INTO result_row FROM library.components WHERE component_id = p_component_id;
  RETURN result_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.lib_archive_component(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.lib_upsert_variant(
  p_variant_id   TEXT,
  p_hook_id      UUID,
  p_body_angle_id UUID,
  p_scene_id     UUID,
  p_creator_id   UUID,
  p_iteration    INT DEFAULT 1,
  p_status       TEXT DEFAULT 'planned',
  p_asset_url    TEXT DEFAULT NULL,
  p_notes        TEXT DEFAULT NULL,
  p_meta_ad_id   TEXT DEFAULT NULL,
  p_meta_ad_name TEXT DEFAULT NULL
)
RETURNS public.lib_variants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, library
AS $$
DECLARE result_row public.lib_variants;
BEGIN
  IF p_status NOT IN ('planned', 'editing', 'ready', 'live', 'paused', 'killed', 'winner') THEN
    RAISE EXCEPTION 'Invalid variant status: %', p_status;
  END IF;

  INSERT INTO library.variants
    (variant_id, hook_id, body_angle_id, scene_id, creator_id, iteration, status, asset_url, notes, meta_ad_id, meta_ad_name, launched_at)
  VALUES
    (p_variant_id, p_hook_id, p_body_angle_id, p_scene_id, p_creator_id, p_iteration, p_status, p_asset_url, p_notes, p_meta_ad_id, p_meta_ad_name,
     CASE WHEN p_status = 'live' THEN NOW() ELSE NULL END)
  ON CONFLICT (variant_id) DO UPDATE SET
    hook_id       = EXCLUDED.hook_id,
    body_angle_id = EXCLUDED.body_angle_id,
    scene_id      = EXCLUDED.scene_id,
    creator_id    = EXCLUDED.creator_id,
    iteration     = EXCLUDED.iteration,
    status        = EXCLUDED.status,
    asset_url     = EXCLUDED.asset_url,
    notes         = EXCLUDED.notes,
    meta_ad_id    = COALESCE(EXCLUDED.meta_ad_id, library.variants.meta_ad_id),
    meta_ad_name  = COALESCE(EXCLUDED.meta_ad_name, library.variants.meta_ad_name),
    launched_at   = CASE
                      WHEN EXCLUDED.status = 'live' AND library.variants.launched_at IS NULL THEN NOW()
                      ELSE library.variants.launched_at
                    END,
    updated_at    = NOW();

  SELECT * INTO result_row FROM library.variants WHERE variant_id = p_variant_id;
  RETURN result_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lib_upsert_variant(TEXT, UUID, UUID, UUID, UUID, INT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- Tag-to-variant: link an existing public.ads row to an existing variant.
-- Used by the Orphans-tab resolution flow + the Ad Detail "Tag" button.
CREATE OR REPLACE FUNCTION public.tag_ad_with_variant(
  p_ad_id      TEXT,
  p_variant_id TEXT
)
RETURNS public.ads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, library
AS $$
DECLARE result_row public.ads;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM library.variants WHERE variant_id = p_variant_id) THEN
    RAISE EXCEPTION 'Variant % does not exist in library.variants.', p_variant_id;
  END IF;

  UPDATE public.ads
     SET variant_id = p_variant_id,
         variant_match_status = 'matched'
   WHERE ad_id = p_ad_id;

  -- Mark the orphan as resolved if it was logged
  UPDATE library.orphan_ads
     SET resolved = TRUE
   WHERE meta_ad_id = p_ad_id;

  -- Backfill the variant's meta_ad_id if empty
  UPDATE library.variants
     SET meta_ad_id   = p_ad_id,
         meta_ad_name = (SELECT ad_name FROM public.ads WHERE ad_id = p_ad_id),
         launched_at  = COALESCE(launched_at, NOW())
   WHERE variant_id = p_variant_id AND meta_ad_id IS NULL;

  SELECT * INTO result_row FROM public.ads WHERE ad_id = p_ad_id;
  RETURN result_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.tag_ad_with_variant(TEXT, TEXT) TO authenticated, service_role;

-- Mark orphan as ignored (resolved without mapping)
CREATE OR REPLACE FUNCTION public.ignore_orphan_ad(p_meta_ad_id TEXT)
RETURNS public.lib_orphan_ads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, library
AS $$
DECLARE result_row public.lib_orphan_ads;
BEGIN
  UPDATE library.orphan_ads
     SET resolved = TRUE
   WHERE meta_ad_id = p_meta_ad_id;
  SELECT * INTO result_row FROM public.lib_orphan_ads WHERE meta_ad_id = p_meta_ad_id;
  RETURN result_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.ignore_orphan_ad(TEXT) TO authenticated, service_role;

-- ── 3. Storage bucket for component assets ─────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('creative_components', 'creative_components', true, 104857600)  -- 100 MB
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit;

-- Public read so we can show videos / images without signed URLs.
DO $$ BEGIN
  CREATE POLICY "Public read creative_components"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'creative_components');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Authenticated upload.
DO $$ BEGIN
  CREATE POLICY "Authenticated upload creative_components"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'creative_components');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Authenticated update (overwrite same path).
DO $$ BEGIN
  CREATE POLICY "Authenticated update creative_components"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (bucket_id = 'creative_components')
    WITH CHECK (bucket_id = 'creative_components');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Authenticated delete.
DO $$ BEGIN
  CREATE POLICY "Authenticated delete creative_components"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (bucket_id = 'creative_components');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
