-- 100_widen_creative_uploads_mime.sql
--
-- Editors uploading an edited cut to their task were getting upload
-- failures (surfaced as a generic error) when the file was NOT one of a
-- narrow set of containers. The `creative-uploads` bucket's
-- allowed_mime_types only permitted mp4 / quicktime / webm / m4v, so any
-- editor exporting .mkv (OBS default!), .avi, .mpeg, .wmv — or any file
-- the browser couldn't sniff a type for (application/octet-stream) — was
-- rejected by the storage layer with `400 invalid_mime_type`.
--
-- This was NOT an RLS problem: RLS on storage.objects + every lib_* table
-- is allow-all for authenticated users (verified by reproducing the full
-- upload path as a real authenticated user against prod). The blocker was
-- purely the bucket's MIME whitelist.
--
-- Fix: widen allowed_mime_types to every container/codec editors realistically
-- export, plus application/octet-stream as the unknown-type fallback. The
-- 10 GB file_size_limit (migration via storage config) still bounds abuse,
-- and this bucket is auth-gated internal-only — there's no public upload
-- surface. Applied live via the storage admin API on 2026-05-28; this file
-- records the change so a bucket re-provision keeps it.

BEGIN;

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  -- video containers
  'video/mp4','video/quicktime','video/webm','video/x-m4v',
  'video/x-matroska','video/x-msvideo','video/avi','video/mpeg',
  'video/x-ms-wmv','video/3gpp','video/3gpp2','video/ogg',
  'video/mp2t','video/x-flv','application/mxf',
  -- unknown-type fallback (browser could not determine a MIME type)
  'application/octet-stream',
  -- audio
  'audio/mpeg','audio/mp4','audio/x-m4a','audio/wav','audio/aac','audio/ogg',
  -- images
  'image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif',
  'image/tiff','image/bmp','image/svg+xml'
]
WHERE id = 'creative-uploads';

COMMIT;
