#!/usr/bin/env node
// One-off + repeatable thumbnail backfill for lib_creative_library rows
// missing thumbnail_url.
//
// Why: browser-side captureVideoThumbnail() skips files > 500 MB because
// moov-at-end MP4s would force the browser to download the whole file
// just to seek. Sony XAVC files from Ben's camera land at 600 MB - 1 GB.
// ffmpeg, by contrast, talks HTTP range requests directly and can grab
// a frame from these in ~4s without downloading the rest.
//
// Pipeline per row:
//   1. ffmpeg -ss 1 -i <preview_url> -frames:v 1 -vf scale=720:-2 thumb.jpg
//   2. Upload to Supabase Storage at creative-thumbnails/by-id/<id>.jpg
//      (matches the path convention used by the upload pipeline already)
//   3. PATCH lib_creative_library SET thumbnail_url = <public url>
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=$(cat /tmp/svc) node scripts/backfill-thumbnails.mjs
//
// Idempotent — re-run safely; only operates on rows where thumbnail_url
// IS NULL.

import { readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SUPABASE = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SVC) {
  console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY env var required')
  process.exit(1)
}

const WORK_DIR = join(tmpdir(), 'thumb-backfill-' + Date.now())
mkdirSync(WORK_DIR, { recursive: true })

async function fetchMissing() {
  const url = `${SUPABASE}/rest/v1/lib_creative_library?select=id,name,canonical_name,type,preview_url&thumbnail_url=is.null&preview_url=not.is.null&exclude_from_library=eq.false&order=type,name`
  const r = await fetch(url, {
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
  })
  if (!r.ok) throw new Error(`fetch missing failed: ${r.status} ${await r.text()}`)
  return await r.json()
}

function extractThumb(srcUrl, outPath) {
  // -ss 1 BEFORE -i = input seek (fast). -frames:v 1 = one frame.
  // -update 1 = single image (no sequence pattern). scale=720:-2 = 720w,
  // keep aspect. -q:v 3 = decent JPEG quality.
  const args = [
    '-y', '-loglevel', 'error',
    '-ss', '1',
    '-i', srcUrl,
    '-frames:v', '1',
    '-update', '1',
    '-vf', 'scale=720:-2',
    '-q:v', '3',
    outPath,
  ]
  const r = spawnSync('ffmpeg', args, { encoding: 'utf-8' })
  if (r.status !== 0) {
    throw new Error(`ffmpeg exit ${r.status}: ${r.stderr?.slice(0, 300)}`)
  }
}

async function uploadThumb(creativeId, localPath) {
  const blob = readFileSync(localPath)
  const path = `by-id/${creativeId}.jpg`
  const url = `${SUPABASE}/storage/v1/object/creative-thumbnails/${path}`
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SVC,
      Authorization: `Bearer ${SVC}`,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'true',
    },
    body: blob,
  })
  if (!r.ok) throw new Error(`upload failed: ${r.status} ${await r.text()}`)
  return `${SUPABASE}/storage/v1/object/public/creative-thumbnails/${path}`
}

async function patchRow(creativeId, thumbUrl) {
  const url = `${SUPABASE}/rest/v1/lib_creative_library?id=eq.${creativeId}`
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SVC,
      Authorization: `Bearer ${SVC}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ thumbnail_url: thumbUrl }),
  })
  if (!r.ok) throw new Error(`patch failed: ${r.status} ${await r.text()}`)
}

async function main() {
  const rows = await fetchMissing()
  console.log(`Found ${rows.length} rows missing thumbnails. Starting...`)
  let ok = 0, fail = 0
  for (const row of rows) {
    const local = join(WORK_DIR, `${row.id}.jpg`)
    const label = `${row.type || '?'} · ${row.canonical_name || row.name || row.id.slice(0, 8)}`
    try {
      const t0 = Date.now()
      extractThumb(row.preview_url, local)
      const thumbUrl = await uploadThumb(row.id, local)
      await patchRow(row.id, thumbUrl)
      const dt = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`  OK   ${label} (${dt}s)`)
      ok++
    } catch (e) {
      console.log(`  FAIL ${label} -- ${e.message}`)
      fail++
    }
  }
  console.log(`\nDone: ${ok}/${rows.length} extracted, ${fail} failed`)
  try { rmSync(WORK_DIR, { recursive: true, force: true }) } catch {}
}

main().catch(e => { console.error(e); process.exit(1) })
