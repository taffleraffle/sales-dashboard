-- 085_creative_uploads_storage_policies.sql
--
-- The `creative-uploads` and `creative-thumbnails` buckets are flagged
-- public:true so anonymous READS work, but storage.objects has RLS
-- enabled and there's no policy allowing anon WRITES. That's why every
-- "Upload new version" / "Upload edited version" attempt fails with
-- "new row violates row-level security policy".
--
-- The buckets are used by Ben's internal Creative Library tools only —
-- there's no public-facing upload surface. So we grant anon + auth
-- full read/write/update/delete on both buckets, matching the pattern
-- used for `ad-source-videos`.

BEGIN;

-- creative-uploads (full-size previews, edited cuts, new versions)
DROP POLICY IF EXISTS "creative-uploads: read"   ON storage.objects;
DROP POLICY IF EXISTS "creative-uploads: write"  ON storage.objects;
DROP POLICY IF EXISTS "creative-uploads: update" ON storage.objects;
DROP POLICY IF EXISTS "creative-uploads: delete" ON storage.objects;

CREATE POLICY "creative-uploads: read"   ON storage.objects FOR SELECT
  USING (bucket_id = 'creative-uploads');
CREATE POLICY "creative-uploads: write"  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'creative-uploads');
CREATE POLICY "creative-uploads: update" ON storage.objects FOR UPDATE
  USING (bucket_id = 'creative-uploads')
  WITH CHECK (bucket_id = 'creative-uploads');
CREATE POLICY "creative-uploads: delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'creative-uploads');

-- creative-thumbnails (small jpgs, written by transcribe-library-clip
-- and creative-library-describe Edge Functions but also occasionally
-- by the dashboard during ingest)
DROP POLICY IF EXISTS "creative-thumbnails: read"   ON storage.objects;
DROP POLICY IF EXISTS "creative-thumbnails: write"  ON storage.objects;
DROP POLICY IF EXISTS "creative-thumbnails: update" ON storage.objects;
DROP POLICY IF EXISTS "creative-thumbnails: delete" ON storage.objects;

CREATE POLICY "creative-thumbnails: read"   ON storage.objects FOR SELECT
  USING (bucket_id = 'creative-thumbnails');
CREATE POLICY "creative-thumbnails: write"  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'creative-thumbnails');
CREATE POLICY "creative-thumbnails: update" ON storage.objects FOR UPDATE
  USING (bucket_id = 'creative-thumbnails')
  WITH CHECK (bucket_id = 'creative-thumbnails');
CREATE POLICY "creative-thumbnails: delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'creative-thumbnails');

NOTIFY pgrst, 'reload schema';

COMMIT;
