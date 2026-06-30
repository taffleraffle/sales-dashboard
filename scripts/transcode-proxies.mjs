#!/usr/bin/env node
/*
  transcode-proxies.mjs — generate small faststart playback proxies (+ poster
  thumbnails) for lib_creative_library clips whose preview_url is a huge raw
  original (e.g. 1.48 GB XAVC). The player streams the proxy for instant inline
  playback; the original stays for download.

  WHY: Supabase doesn't transcode, and edge functions can't run ffmpeg on
  multi-GB files. So this runs wherever ffmpeg + bandwidth live — locally on
  Ben's machine (ffmpeg is on PATH) or a Render worker/cron. Re-running picks
  up any clip still missing a proxy, so the SAME script handles both the
  one-time backfill AND new uploads (run it on a schedule).

  USAGE (creds from sentinel/.env — service_role key, NOT anon):
    SUPABASE_URL=https://kjfaqhmllagbxjdxlopm.supabase.co \
    SUPABASE_SERVICE_KEY=<service_role> \
    node scripts/transcode-proxies.mjs [--limit N] [--id <uuid>] [--concurrency 1]

  Needs the preview_proxy_url column (migrations/024_preview_proxy_url.sql).
*/
import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { mkdtempSync, createWriteStream, statSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const URL_BASE = process.env.SUPABASE_URL || 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SALES_KEY
if (!KEY) { console.error('Set SUPABASE_SERVICE_KEY (service_role) — see sentinel/.env'); process.exit(1) }

const args = process.argv.slice(2)
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d }
const LIMIT = Number(opt('--limit', 25))
const ONLY_ID = opt('--id', null)
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const BUCKET = 'creative-uploads'

// Which table to proxy. Both share the same proxy/poster columns; only the
// source-URL column differs. lib_creative_library plays preview_url (the raw
// upload), lib_task_submissions plays file_url (the editor's cut).
// proxyCol = the column the generated proxy URL is written to (defaults to
// preview_proxy_url). library_edit proxies the EDITED cut (final_cut_url) into
// final_cut_proxy_url for rows whose edit isn't backed by a submission row —
// `editOnly` makes it skip rows where final_cut_url === preview_url (no real
// edit) since PostgREST can't express a column<>column filter server-side.
const TABLES = {
  library:      { table: 'lib_creative_library', srcCol: 'preview_url',   proxyCol: 'preview_proxy_url',   hasDeletedAt: false },
  submissions:  { table: 'lib_task_submissions', srcCol: 'file_url',      proxyCol: 'preview_proxy_url',   hasDeletedAt: true },
  library_edit: { table: 'lib_creative_library', srcCol: 'final_cut_url', proxyCol: 'final_cut_proxy_url', hasDeletedAt: false, editOnly: true },
}
const TABLE = TABLES[opt('--table', 'library')]
if (!TABLE) { console.error('--table must be library|submissions'); process.exit(1) }

const sb = createClient(URL_BASE, KEY, { auth: { persistSession: false } })

function run(cmd, a) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, a, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err += d.toString() })
    p.on('error', rej)
    p.on('close', code => code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`)))
  })
}

async function download(url, dest) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`download ${r.status}`)
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest))
}

// 1-year immutable cache. Proxy filenames are content-unique (`id_timestamp`)
// so they can never go stale. Without this, Supabase serves proxies with
// `Cache-Control: no-cache` → Cloudflare's edge (Ben is on the Auckland PoP)
// REVALIDATES against the US origin on every request AND every scrub-seek, so
// playback + scrubbing pay a trans-Pacific round-trip each time. With it the
// edge serves the bytes straight from Auckland (CF-Cache-Status: HIT).
const CACHE_CONTROL = '31536000'

async function uploadPublic(path, localFile, contentType) {
  const bytes = readFileSync(localFile)
  const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true, cacheControl: CACHE_CONTROL })
  if (error) throw error
  return `${URL_BASE}/storage/v1/object/public/${BUCKET}/${path}`
}

// Re-tag an EXISTING proxy object with the long cache header without
// re-transcoding: download the small proxy and re-upload it to the same path
// with cacheControl set. The stored object's metadata (hence the served
// Cache-Control header) is rewritten; the URL is unchanged so no DB update is
// needed. Used by --retag to fix the back-catalogue uploaded before
// CACHE_CONTROL existed.
function proxyPathFromUrl(url) {
  const m = String(url).match(new RegExp(`/object/public/${BUCKET}/(.+)$`))
  return m ? decodeURIComponent(m[1].split('?')[0]) : null
}
async function retagOne(url) {
  const path = proxyPathFromUrl(url)
  if (!path) return false
  const dir = mkdtempSync(join(tmpdir(), 'opt-retag-'))
  const tmp = join(dir, 'proxy.mp4')
  try {
    await download(url, tmp)
    const ct = path.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4'
    const bytes = readFileSync(tmp)
    const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: ct, upsert: true, cacheControl: CACHE_CONTROL })
    if (error) throw error
    return true
  } catch (e) {
    console.log(`  ✗ retag ${path}: ${e.message}`)
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function retagAll() {
  // Pull every distinct proxy URL across both tables, re-tag each.
  const urls = new Set()
  for (const t of ['lib_creative_library', 'lib_task_submissions']) {
    let from = 0
    for (;;) {
      const { data, error } = await sb.from(t).select('preview_proxy_url').not('preview_proxy_url', 'is', null).range(from, from + 999)
      if (error) { console.error(`${t}:`, error.message); break }
      data.forEach(r => r.preview_proxy_url && urls.add(r.preview_proxy_url))
      if (data.length < 1000) break
      from += 1000
    }
  }
  const list = [...urls]
  console.log(`Re-tagging ${list.length} proxy object(s) with cacheControl=${CACHE_CONTROL}…`)
  let ok = 0
  for (let i = 0; i < list.length; i++) {
    process.stdout.write(`  [${i + 1}/${list.length}] `)
    if (await retagOne(list[i])) { ok++; console.log('✓') }
  }
  console.log(`\nDone. ${ok}/${list.length} re-tagged.`)
}

async function processOne(row) {
  const dir = mkdtempSync(join(tmpdir(), 'opt-proxy-'))
  const orig = join(dir, 'orig'), proxy = join(dir, 'proxy.mp4'), poster = join(dir, 'poster.jpg')
  try {
    process.stdout.write(`  ↓ ${row.id} downloading… `)
    await download(row[TABLE.srcCol], orig)
    const mb = (statSync(orig).size / 1048576).toFixed(0)
    process.stdout.write(`${mb}MB → transcoding… `)
    // 720p, H.264 CRF 26, faststart (moov at front) so it streams instantly.
    await run(FFMPEG, ['-y', '-i', orig,
      '-vf', "scale='-2:min(720,ih)'", '-c:v', 'libx264', '-crf', '26',
      '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', proxy])
    // Poster from the (small) proxy — cheap.
    await run(FFMPEG, ['-y', '-ss', '1', '-i', proxy, '-vframes', '1',
      '-vf', "scale='-2:720'", '-q:v', '4', poster])
    const proxyMb = (statSync(proxy).size / 1048576).toFixed(1)
    process.stdout.write(`proxy ${proxyMb}MB → uploading… `)
    const stamp = Date.now()
    const proxyUrl = await uploadPublic(`proxies/${row.id}_${stamp}.mp4`, proxy, 'video/mp4')
    const posterUrl = await uploadPublic(`proxies/${row.id}_${stamp}.jpg`, poster, 'image/jpeg')
    const patch = { [TABLE.proxyCol]: proxyUrl }
    if (!row.thumbnail_url) patch.thumbnail_url = posterUrl
    const { error } = await sb.from(TABLE.table).update(patch).eq('id', row.id)
    if (error) throw error
    console.log('✓')
    return true
  } catch (e) {
    console.log(`✗ ${e.message}`)
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  if (args.includes('--retag')) { await retagAll(); return }
  // editOnly needs preview_url too so we can skip rows whose "edit" is just the
  // raw (final_cut_url === preview_url) — PostgREST can't filter column<>column.
  const cols = `id, ${TABLE.srcCol}, thumbnail_url${TABLE.editOnly ? ', preview_url' : ''}`
  let q = sb.from(TABLE.table)
    .select(cols)
    .is(TABLE.proxyCol, null)
    .not(TABLE.srcCol, 'is', null)
    .limit(LIMIT)
  if (TABLE.hasDeletedAt) q = q.is('deleted_at', null)
  if (ONLY_ID) {
    // --id is an explicit single-row FORCE (e.g. regenerate a broken proxy):
    // drop the proxy-null guard so it re-transcodes even if a proxy exists.
    q = sb.from(TABLE.table).select(cols).eq('id', ONLY_ID)
  }
  let { data, error } = await q
  if (error) { console.error('query failed:', error.message); process.exit(1) }
  if (TABLE.editOnly && data) data = data.filter(r => r[TABLE.srcCol] !== r.preview_url)
  if (!data?.length) { console.log(`Nothing to transcode — all ${TABLE.table} rows have proxies.`); return }
  console.log(`Transcoding ${data.length} ${TABLE.table} row(s)…`)
  let ok = 0
  for (const row of data) { if (await processOne(row)) ok++ }
  console.log(`\nDone. ${ok}/${data.length} proxies generated.`)
}

main().catch(e => { console.error(e); process.exit(1) })
