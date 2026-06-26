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

async function uploadPublic(path, localFile, contentType) {
  const bytes = readFileSync(localFile)
  const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true })
  if (error) throw error
  return `${URL_BASE}/storage/v1/object/public/${BUCKET}/${path}`
}

async function processOne(row) {
  const dir = mkdtempSync(join(tmpdir(), 'opt-proxy-'))
  const orig = join(dir, 'orig'), proxy = join(dir, 'proxy.mp4'), poster = join(dir, 'poster.jpg')
  try {
    process.stdout.write(`  ↓ ${row.id} downloading… `)
    await download(row.preview_url, orig)
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
    const patch = { preview_proxy_url: proxyUrl }
    if (!row.thumbnail_url) patch.thumbnail_url = posterUrl
    const { error } = await sb.from('lib_creative_library').update(patch).eq('id', row.id)
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
  let q = sb.from('lib_creative_library')
    .select('id, preview_url, thumbnail_url')
    .is('preview_proxy_url', null)
    .not('preview_url', 'is', null)
    .limit(LIMIT)
  if (ONLY_ID) q = sb.from('lib_creative_library').select('id, preview_url, thumbnail_url').eq('id', ONLY_ID)
  const { data, error } = await q
  if (error) { console.error('query failed:', error.message); process.exit(1) }
  if (!data?.length) { console.log('Nothing to transcode — all clips have proxies.'); return }
  console.log(`Transcoding ${data.length} clip(s)…`)
  let ok = 0
  for (const row of data) { if (await processOne(row)) ok++ }
  console.log(`\nDone. ${ok}/${data.length} proxies generated.`)
}

main().catch(e => { console.error(e); process.exit(1) })
