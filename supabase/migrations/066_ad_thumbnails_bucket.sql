-- 066_ad_thumbnails_bucket.sql
--
-- Permanent storage for ad thumbnails / static creative images.
-- Meta's CDN URLs (scontent-*.xx.fbcdn.net) are signed and expire within
-- hours, which is why some thumbnails on the Creatives page render and
-- others 403. Fix: download once at sync time, store in Supabase Storage,
-- and reference our own permanent public URL going forward.
--
-- Naming convention: <ad_id>.jpg (always JPEG-converted on upload).
-- Public bucket — thumbnails are not sensitive and the same URLs are
-- already pasted into Meta's ad library.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'ad-thumbnails',
  'ad-thumbnails',
  TRUE,
  5 * 1024 * 1024,                          -- 5 MB per thumbnail
  ARRAY['image/jpeg','image/png','image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = TRUE,
  file_size_limit = 5 * 1024 * 1024,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

-- Policies: public read, authenticated/service write (sync runs as
-- service-role or authenticated user; anon should not be allowed to write).
DROP POLICY IF EXISTS "ad-thumbnails: public read"  ON storage.objects;
DROP POLICY IF EXISTS "ad-thumbnails: auth write"   ON storage.objects;
DROP POLICY IF EXISTS "ad-thumbnails: auth update"  ON storage.objects;
DROP POLICY IF EXISTS "ad-thumbnails: auth delete"  ON storage.objects;

CREATE POLICY "ad-thumbnails: public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'ad-thumbnails');

CREATE POLICY "ad-thumbnails: auth write"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'ad-thumbnails' AND auth.role() IN ('authenticated','service_role'));

CREATE POLICY "ad-thumbnails: auth update"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'ad-thumbnails' AND auth.role() IN ('authenticated','service_role'));

CREATE POLICY "ad-thumbnails: auth delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'ad-thumbnails' AND auth.role() IN ('authenticated','service_role'));

COMMIT;
