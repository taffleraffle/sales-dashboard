-- Phase 2 of Ad Performance + Creative Library.
-- Bridges public.ads (raw Meta sync) to library.variants (the SOP-driven library).
-- READ-ONLY against Meta; the parser only inspects ad_name strings already in DB.
--
-- Pre-req: 011_ad_performance_phase1.sql + supabase/migrations/027_library_schema.sql.

-- ── 1. Link columns on public.ads ───────────────────────────────────────────
ALTER TABLE public.ads
  ADD COLUMN IF NOT EXISTS variant_id TEXT REFERENCES library.variants(variant_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS variant_match_status TEXT
    CHECK (variant_match_status IN ('matched', 'orphan', 'legacy', 'unparsed', 'pending'))
    DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_ads_variant_id ON public.ads(variant_id);
CREATE INDEX IF NOT EXISTS idx_ads_variant_match_status ON public.ads(variant_match_status);

-- ── 2. Parser: regex-extract variant_id from a Meta ad name ────────────────
--
-- variant_id grammar per OPT-MetaAd-Naming-SOP-v2-2026-05-09:
--   H{n}.{m}?_BA-{TYPE}_S-{TYPE}_{CREATOR}_v{n}
-- e.g. H4.2_BA-PROOF_S-OFFICE_OSO_v1
--
-- Full Meta ad name encloses it: [CAMPAIGN] | [AUDIENCE] | [variant_id] | [iteration]
CREATE OR REPLACE FUNCTION library.parse_variant_id(ad_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
AS $$
DECLARE
  match_with_v   TEXT;
  match_no_v     TEXT;
BEGIN
  IF ad_name IS NULL THEN RETURN NULL; END IF;

  -- Prefer the version-suffixed form (full variant_id including _v#)
  SELECT (regexp_match(ad_name,
    'H[0-9]+(?:\.[0-9]+)?_BA-[A-Z\-]+_S-[A-Z\-]+_[A-Z\-]+_v[0-9]+'
  ))[1] INTO match_with_v;
  IF match_with_v IS NOT NULL THEN RETURN match_with_v; END IF;

  -- Fall back to the un-versioned form (variant id without _v# is sometimes
  -- placed in field 3 of the ad name, with the iteration in field 4)
  SELECT (regexp_match(ad_name,
    'H[0-9]+(?:\.[0-9]+)?_BA-[A-Z\-]+_S-[A-Z\-]+_[A-Z\-]+'
  ))[1] INTO match_no_v;
  RETURN match_no_v;
END;
$$;

-- ── 3. Trigger function: link an ads row to its variant on insert/update ───
CREATE OR REPLACE FUNCTION public.link_ad_to_variant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  parsed_id          TEXT;
  matched_variant_id TEXT;
  legacy_variant_pk  UUID;
  legacy_variant_id  TEXT;
BEGIN
  parsed_id := library.parse_variant_id(NEW.ad_name);

  IF parsed_id IS NULL THEN
    -- Name doesn't match the SOP grammar. Try legacy mapping.
    SELECT lm.variant_id INTO legacy_variant_pk
    FROM library.legacy_ad_mapping lm
    WHERE lm.meta_ad_id = NEW.ad_id;

    IF legacy_variant_pk IS NOT NULL THEN
      SELECT v.variant_id INTO legacy_variant_id
      FROM library.variants v WHERE v.id = legacy_variant_pk;
      NEW.variant_id := legacy_variant_id;
      NEW.variant_match_status := 'legacy';
    ELSE
      NEW.variant_match_status := 'unparsed';
      INSERT INTO library.orphan_ads (meta_ad_id, meta_ad_name, parser_attempted)
      VALUES (NEW.ad_id, NEW.ad_name, 'no SOP match in name')
      ON CONFLICT (meta_ad_id) DO UPDATE SET
        last_seen        = NOW(),
        meta_ad_name     = EXCLUDED.meta_ad_name,
        parser_attempted = EXCLUDED.parser_attempted;
    END IF;
  ELSE
    -- Try exact match first, then prefix match (in case the parsed id is the
    -- non-versioned form and the library entry is versioned).
    SELECT v.variant_id INTO matched_variant_id
    FROM library.variants v
    WHERE v.variant_id = parsed_id
       OR v.variant_id LIKE parsed_id || '_v%'
    ORDER BY v.variant_id DESC
    LIMIT 1;

    IF matched_variant_id IS NOT NULL THEN
      NEW.variant_id := matched_variant_id;
      NEW.variant_match_status := 'matched';

      -- Backfill the variant's meta_ad_id if it's empty.
      UPDATE library.variants
         SET meta_ad_id   = NEW.ad_id,
             meta_ad_name = NEW.ad_name,
             launched_at  = COALESCE(launched_at, NOW())
       WHERE variant_id = matched_variant_id
         AND meta_ad_id IS NULL;
    ELSE
      NEW.variant_match_status := 'orphan';
      INSERT INTO library.orphan_ads (meta_ad_id, meta_ad_name, parser_attempted)
      VALUES (NEW.ad_id, NEW.ad_name, parsed_id)
      ON CONFLICT (meta_ad_id) DO UPDATE SET
        last_seen        = NOW(),
        parser_attempted = EXCLUDED.parser_attempted;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ads_link_to_variant ON public.ads;
CREATE TRIGGER ads_link_to_variant
  BEFORE INSERT OR UPDATE OF ad_name ON public.ads
  FOR EACH ROW EXECUTE FUNCTION public.link_ad_to_variant();

-- ── 4. Trigger function: mirror ad_daily_stats into library.performance_daily ─
--
-- Only mirrors when the ad is linked to a variant. The library view's weighted
-- rates (hook_rate, hold_rate, cpa) recompute from these rows on materialized
-- view refresh. Source flag stays 'meta' here; HYROS-augmented rows would
-- update the same key with source='merged' on a separate sync.
CREATE OR REPLACE FUNCTION public.mirror_stats_to_library()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_uuid UUID;
BEGIN
  SELECT v.id INTO v_uuid
  FROM library.variants v
  JOIN public.ads a ON a.variant_id = v.variant_id
  WHERE a.ad_id = NEW.ad_id;

  IF v_uuid IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO library.performance_daily (
    variant_id, date, spend, impressions, reach, clicks, link_clicks,
    three_sec_views, thruplays, source, pulled_at
  ) VALUES (
    v_uuid, NEW.date,
    COALESCE(NEW.spend, 0),
    COALESCE(NEW.impressions, 0),
    COALESCE(NEW.reach, 0),
    COALESCE(NEW.clicks, 0),
    COALESCE(NEW.unique_clicks, 0),
    COALESCE(NEW.video_3s_views, 0),
    COALESCE(NEW.video_thruplays, 0),
    'meta', NOW()
  )
  ON CONFLICT (variant_id, date) DO UPDATE SET
    spend           = EXCLUDED.spend,
    impressions     = EXCLUDED.impressions,
    reach           = EXCLUDED.reach,
    clicks          = EXCLUDED.clicks,
    link_clicks     = EXCLUDED.link_clicks,
    three_sec_views = EXCLUDED.three_sec_views,
    thruplays       = EXCLUDED.thruplays,
    pulled_at       = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ad_daily_stats_mirror ON public.ad_daily_stats;
CREATE TRIGGER ad_daily_stats_mirror
  AFTER INSERT OR UPDATE ON public.ad_daily_stats
  FOR EACH ROW EXECUTE FUNCTION public.mirror_stats_to_library();

-- ── 5. RPC wrapper for the materialized-view refresh ───────────────────────
--
-- library.refresh_materialized_views() exists in 027 but is not exposed via
-- PostgREST because PostgREST only exposes functions in the schema it's been
-- told to expose. Wrap it in public so the dashboard can invoke it.
CREATE OR REPLACE FUNCTION public.refresh_ad_library_views()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER  -- so the authenticated role can refresh views without owning them
SET search_path = public, library
AS $$
BEGIN
  PERFORM library.refresh_materialized_views();
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_ad_library_views() TO authenticated, service_role;

-- ── 6. Schema-cache reload ─────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
