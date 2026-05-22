// replace-from-local-files.mjs
//
// Takes a JSON-encoded list of {local_path, library_id, label} pairs and
// runs the same in-place TUS replace flow that the CreativeDetailModal
// "Replace original" button does — but for a batch from CLI. Used to
// restore damaged restoration rows from Drive originals downloaded
// locally via gdown.
//
// For each pair:
//   1. TUS-upload local_path to incoming/<library_id>_replaced_<ts>_<name>
//   2. PATCH the row: preview_url, size_mb, clear all is_low_quality flags
//      + low_quality_reason + low_quality_actual_mb + low_quality_detected_at,
//      set source_bucket = 'Drive original restored 2026-05-22'
//   3. Fire transcribe-library-clip -> identify-actor -> creative-library-describe
//      so transcript + creator + canonical_name regenerate from HQ audio
//
// PRESERVES THE ROW ID — editor task assignments, derived hook/body links,
// manual creator picks all survive.
//
// Usage:
//   node scripts/replace-from-local-files.mjs '[{"local_path":"...","library_id":"...","label":"..."}]'

import { createClient } from '@supabase/supabase-js'
import * as tus from 'tus-js-client'
import { readFileSync, statSync, createReadStream, openSync, readSync, closeSync } from 'node:fs'
import { basename } from 'node:path'

const SUPABASE_URL = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const jobsArg = process.argv[2]
if (!jobsArg) { console.error('Pass a JSON file path containing array of {local_path,library_id,label}'); process.exit(1) }
// PowerShell can mangle inline JSON arg-passing (strips quotes). Always
// pass a file path to the JSON instead — much more reliable on Windows.
const jobs = JSON.parse(readFileSync(jobsArg, 'utf-8'))

async function tusUpload(localPath, bucket, path, contentType) {
  const totalSize = statSync(localPath).size
  // For files >1.5 GB the Buffer approach hits the 2 GiB Node limit.
  // Use a streaming ReadStream instead — tus-js-client supports this in
  // Node when uploadSize is provided. Smaller files use a Buffer for
  // speed (no per-chunk filesystem seeks).
  const useStream = totalSize >= 1.5 * 1024 * 1024 * 1024
  const source = useStream
    ? createReadStream(localPath, { highWaterMark: 8 * 1024 * 1024 })
    : readFileSync(localPath)
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(source, {
      endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: useStream ? [] : [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${SERVICE_KEY}`,
        'x-upsert': 'false',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType,
        cacheControl: '3600',
      },
      chunkSize: 6 * 1024 * 1024,
      uploadSize: totalSize,
      onError: reject,
      onProgress: (loaded, total) => {
        const pct = Math.round((loaded / total) * 100)
        process.stdout.write(`\r    uploading ${pct}% (${Math.round(loaded/1024/1024)}/${Math.round(total/1024/1024)} MB)`)
      },
      onSuccess: () => { process.stdout.write('\n'); resolve() },
    })
    upload.start()
  })
}

const STAMP = new Date().toISOString().slice(0, 10)

for (const job of jobs) {
  const { local_path, library_id, label } = job
  console.log(`\n=== ${label} -> ${library_id} ===`)
  const size = statSync(local_path).size
  const sizeMB = Math.round(size / 1024 / 1024 * 10) / 10
  console.log(`  source: ${local_path} (${sizeMB} MB)`)

  const sanitized = basename(local_path).replace(/[^A-Za-z0-9._-]+/g, '_')
  const storagePath = `incoming/${library_id}_replaced_${Date.now()}_${sanitized}`
  try {
    await tusUpload(local_path, 'creative-uploads', storagePath, 'video/mp4')
  } catch (e) {
    console.log(`  UPLOAD FAILED: ${e?.message || e}`)
    continue
  }
  const newUrl = `${SUPABASE_URL}/storage/v1/object/public/creative-uploads/${storagePath}`
  console.log(`  uploaded: ${newUrl}`)

  // Capture old row state for the notes audit trail
  const { data: oldRow } = await supabase
    .from('lib_creative_library')
    .select('low_quality_reason, low_quality_actual_mb, notes')
    .eq('id', library_id)
    .single()

  const newNotes = `Source replaced ${STAMP} via Drive original. Was '${oldRow?.low_quality_reason || 'damaged'}' (${oldRow?.low_quality_actual_mb ?? '?'} MB on disk).\n\n${oldRow?.notes || ''}`.trim()

  const { error: upErr } = await supabase
    .from('lib_creative_library')
    .update({
      preview_url: newUrl,
      size_mb: sizeMB,
      is_low_quality: false,
      low_quality_reason: null,
      low_quality_actual_mb: null,
      low_quality_detected_at: null,
      source_bucket: 'Drive original restored 2026-05-22',
      notes: newNotes,
    })
    .eq('id', library_id)
  if (upErr) { console.log(`  PATCH FAILED: ${upErr.message}`); continue }
  console.log(`  patched DB`)

  // Fire transcribe + identify + describe pipeline best-effort
  try {
    await supabase.functions.invoke('transcribe-library-clip', {
      body: { library_id, storage_path: storagePath },
    })
    console.log(`  transcribe queued`)
  } catch (e) { console.log(`  transcribe err (non-fatal): ${e?.message || e}`) }
  try {
    await supabase.functions.invoke('identify-actor', { body: { library_ids: [library_id] } })
    console.log(`  identify-actor queued`)
  } catch (e) { console.log(`  identify-actor err (non-fatal): ${e?.message || e}`) }
  try {
    await supabase.functions.invoke('creative-library-describe', { body: { library_ids: [library_id] } })
    console.log(`  describe queued`)
  } catch (e) { console.log(`  describe err (non-fatal): ${e?.message || e}`) }
}

console.log('\nAll done.')
