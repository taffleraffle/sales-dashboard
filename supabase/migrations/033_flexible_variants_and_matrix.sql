-- 033_flexible_variants_and_matrix.sql
-- Two changes for the spreadsheet-style Variants rebuild:
--
-- 1. Make all the canonical-type FKs on library.variants NULLABLE so the
--    operator can create a variant with just hook+body (or even just hook)
--    without being forced to pick a scene + creator. Atomic clip refs
--    (hook_clip_id etc.) are already nullable from migration 032.
--
-- 2. Add a bulk INSERT RPC (lib_variant_upsert + lib_variant_bulk_create_from_clips)
--    so the matrix generator can spawn N variants in one round-trip when
--    the operator picks hook-clips × body-clips × creators.

BEGIN;

ALTER TABLE library.variants ALTER COLUMN hook_id        DROP NOT NULL;
ALTER TABLE library.variants ALTER COLUMN body_angle_id  DROP NOT NULL;
ALTER TABLE library.variants ALTER COLUMN scene_id       DROP NOT NULL;
ALTER TABLE library.variants ALTER COLUMN creator_id     DROP NOT NULL;

-- Single-row upsert RPC. Mirrors lib_clip_upsert from migration 032.
CREATE OR REPLACE FUNCTION public.lib_variant_upsert(
  p_variant_id     TEXT,
  p_status         TEXT DEFAULT 'planned',
  p_iteration      INTEGER DEFAULT 1,
  p_hook_clip_id   TEXT DEFAULT NULL,
  p_body_clip_id   TEXT DEFAULT NULL,
  p_frame_clip_id  TEXT DEFAULT NULL,
  p_creator_id     UUID DEFAULT NULL,
  p_editor         TEXT DEFAULT NULL,
  p_priority       TEXT DEFAULT NULL,
  p_meta_ad_id     TEXT DEFAULT NULL,
  p_meta_ad_name   TEXT DEFAULT NULL,
  p_notes          TEXT DEFAULT NULL
) RETURNS library.variants
LANGUAGE plpgsql SECURITY DEFINER SET search_path = library, public
AS $$
DECLARE
  out_row library.variants;
BEGIN
  INSERT INTO library.variants (
    variant_id, status, iteration, hook_clip_id, body_clip_id, frame_clip_id,
    creator_id, editor, priority, meta_ad_id, meta_ad_name, notes
  ) VALUES (
    p_variant_id, COALESCE(p_status, 'planned'), COALESCE(p_iteration, 1),
    p_hook_clip_id, p_body_clip_id, p_frame_clip_id,
    p_creator_id, p_editor, p_priority, p_meta_ad_id, p_meta_ad_name, p_notes
  )
  ON CONFLICT (variant_id) DO UPDATE SET
    status       = EXCLUDED.status,
    iteration    = EXCLUDED.iteration,
    hook_clip_id = EXCLUDED.hook_clip_id,
    body_clip_id = EXCLUDED.body_clip_id,
    frame_clip_id = EXCLUDED.frame_clip_id,
    creator_id   = EXCLUDED.creator_id,
    editor       = EXCLUDED.editor,
    priority     = EXCLUDED.priority,
    meta_ad_id   = EXCLUDED.meta_ad_id,
    meta_ad_name = EXCLUDED.meta_ad_name,
    notes        = EXCLUDED.notes,
    updated_at   = NOW()
  RETURNING * INTO out_row;
  RETURN out_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.lib_variant_delete(p_variant_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = library, public
AS $$
BEGIN
  DELETE FROM library.variants WHERE variant_id = p_variant_id;
  RETURN FOUND;
END;
$$;

-- Matrix generator. Takes arrays of hook_clip_ids and body_clip_ids (each
-- nullable), plus optional frame_clip_id and creator_id, and inserts the
-- full cross-product of variants. variant_id = HOOK_BODY[_FRAME] auto-derived
-- when not explicitly overridden.
CREATE OR REPLACE FUNCTION public.lib_variants_bulk_from_clips(
  p_hook_clip_ids  TEXT[],
  p_body_clip_ids  TEXT[],
  p_frame_clip_id  TEXT DEFAULT NULL,
  p_editor         TEXT DEFAULT NULL,
  p_priority       TEXT DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = library, public
AS $$
DECLARE
  h TEXT;
  b TEXT;
  vid TEXT;
  inserted INTEGER := 0;
BEGIN
  -- Handle the "only hooks selected, no bodies" case: treat as a single-body
  -- iteration with NULL body_clip_id. Same for the inverse.
  IF p_hook_clip_ids IS NULL OR array_length(p_hook_clip_ids, 1) IS NULL THEN
    p_hook_clip_ids := ARRAY[NULL]::TEXT[];
  END IF;
  IF p_body_clip_ids IS NULL OR array_length(p_body_clip_ids, 1) IS NULL THEN
    p_body_clip_ids := ARRAY[NULL]::TEXT[];
  END IF;

  FOREACH h IN ARRAY p_hook_clip_ids LOOP
    FOREACH b IN ARRAY p_body_clip_ids LOOP
      -- Compose a deterministic variant_id from whatever was supplied
      vid := COALESCE(h, 'NOHOOK') || '_' || COALESCE(b, 'NOBODY');
      IF p_frame_clip_id IS NOT NULL THEN
        vid := vid || '_' || p_frame_clip_id;
      END IF;

      INSERT INTO library.variants (
        variant_id, status, iteration, hook_clip_id, body_clip_id, frame_clip_id,
        editor, priority
      ) VALUES (
        vid, 'planned', 1, h, b, p_frame_clip_id, p_editor, p_priority
      )
      ON CONFLICT (variant_id) DO NOTHING;

      IF FOUND THEN inserted := inserted + 1; END IF;
    END LOOP;
  END LOOP;

  RETURN inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lib_variant_upsert            TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lib_variant_delete            TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lib_variants_bulk_from_clips  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
