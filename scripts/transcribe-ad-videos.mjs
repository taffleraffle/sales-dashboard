#!/usr/bin/env node
/**
 * Pulls all ad videos from the Meta account, downloads each, runs OpenAI
 * Whisper to transcribe the audio, and writes the result into
 * library.creative_transcripts as source='whisper_api'.
 *
 * Incremental: only transcribes videos we don't already have a transcript
 * for. Re-run cheaply after every Meta sync to catch new ads.
 *
 * Cost: ~$0.006 / minute of audio. 370 ads × 60s avg ≈ $2.20 first full run.
 *
 * Setup:
 *   - VITE_META_ADS_ACCOUNT_ID + VITE_META_ADS_ACCESS_TOKEN already in .env
 *   - VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY already in .env
 *   - OPENAI_API_KEY    must be added to .env (NOT Vite-prefixed since this is server-only)
 *
 * Run: node scripts/transcribe-ad-videos.mjs [maxVideosToTranscribe]
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')] })
)

const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_KEY = env.VITE_SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY
const ACCOUNT_ID   = env.VITE_META_ADS_ACCOUNT_ID
const META_TOKEN   = env.VITE_META_ADS_ACCESS_TOKEN
const OPENAI_KEY   = env.OPENAI_API_KEY

if (!SUPABASE_URL || !SUPABASE_KEY || !ACCOUNT_ID || !META_TOKEN) {
  console.error('Missing Meta or Supabase env. Check .env')
  process.exit(1)
}
if (!OPENAI_KEY) {
  console.error('Missing OPENAI_API_KEY in .env. Whisper transcription requires it.')
  console.error('Get a key at https://platform.openai.com/api-keys and add to .env as OPENAI_API_KEY=sk-...')
  process.exit(1)
}

const MAX_RUN = parseInt(process.argv[2] || '50')   // safety cap so first runs don't burn through the whole library
const TMP_DIR = join(tmpdir(), 'opt-ad-transcribe')
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true })

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

// ────────────────────────────────────────────────────────────────────
// 1 · Pull all advideos with source URLs
// ────────────────────────────────────────────────────────────────────
console.log(`[transcribe] fetching ad video catalog from Meta account ${ACCOUNT_ID}`)
const videoMap = new Map() // video_id -> { source, length, title }
let pageNum = 0
let videoUrl = `https://graph.facebook.com/v21.0/act_${ACCOUNT_ID}/advideos?` + new URLSearchParams({
  access_token: META_TOKEN,
  fields: 'id,title,source,length',
  limit: '200',
}).toString()

while (videoUrl) {
  pageNum++
  const res = await fetch(videoUrl)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error(`[transcribe] advideos page ${pageNum} HTTP ${res.status}:`, err.error?.message || res.statusText)
    process.exit(2)
  }
  const json = await res.json()
  for (const v of json.data || []) {
    if (v.id && v.source) videoMap.set(v.id, { source: v.source, length: v.length || 0, title: v.title || '' })
  }
  console.log(`[transcribe] advideos page ${pageNum}: total catalog = ${videoMap.size}`)
  videoUrl = json.paging?.next || null
}

if (videoMap.size === 0) {
  console.error('[transcribe] no videos returned by Meta — token scope or account state issue.')
  process.exit(3)
}

// ────────────────────────────────────────────────────────────────────
// 2 · Map ad_id -> video_id from public.ads.raw_payload.creative.video_id
// ────────────────────────────────────────────────────────────────────
console.log(`[transcribe] joining catalog to public.ads ...`)
const { data: adsRows, error: adsErr } = await supabase
  .from('ads')
  .select('ad_id, ad_name, raw_payload, asset_type')
  .eq('asset_type', 'video')
const ads = adsErr ? [] : (adsRows || [])
if (adsErr) console.error('[transcribe] ads read error:', adsErr.message)
console.log(`[transcribe] ${ads.length} video ads found in public.ads`)

const adVideoPairs = []
for (const ad of ads) {
  const c = ad.raw_payload?.creative
  const oss = c?.object_story_spec || {}
  const vid = c?.video_id || oss.video_data?.video_id
  if (!vid) continue
  const v = videoMap.get(vid)
  if (!v) continue
  adVideoPairs.push({ ad_id: ad.ad_id, ad_name: ad.ad_name, video_id: vid, ...v })
}
console.log(`[transcribe] ${adVideoPairs.length} ads have a downloadable video source`)

// ────────────────────────────────────────────────────────────────────
// 3 · Filter to ads that don't yet have a Whisper transcript
// ────────────────────────────────────────────────────────────────────
const { data: existing, error: tErr } = await supabase
  .from('lib_creative_transcripts')
  .select('ad_id, source')
  .eq('source', 'whisper_api')
if (tErr) {
  console.error('[transcribe] transcript read error:', tErr.message)
  process.exit(4)
}
const alreadyDone = new Set((existing || []).map(r => r.ad_id))
const todo = adVideoPairs.filter(p => !alreadyDone.has(p.ad_id))
console.log(`[transcribe] ${todo.length} ads need transcription (skipping ${alreadyDone.size} already done)`)

if (todo.length === 0) {
  console.log('[transcribe] nothing to do.')
  process.exit(0)
}

const slice = todo.slice(0, MAX_RUN)
console.log(`[transcribe] processing ${slice.length} of ${todo.length} (cap = ${MAX_RUN})`)
console.log(`[transcribe] est. cost ≈ $${(slice.reduce((s, p) => s + p.length, 0) / 60 * 0.006).toFixed(2)}`)

// ────────────────────────────────────────────────────────────────────
// 4 · Download + transcribe each video
// ────────────────────────────────────────────────────────────────────
const startedAt = Date.now()
let done = 0, errors = 0
for (const p of slice) {
  const tmpPath = join(TMP_DIR, `${p.ad_id}.mp4`)
  try {
    // Download
    const dl = await fetch(p.source)
    if (!dl.ok) throw new Error(`download HTTP ${dl.status}`)
    const buf = Buffer.from(await dl.arrayBuffer())
    writeFileSync(tmpPath, buf)

    // Transcribe via OpenAI Whisper. Form-data multipart upload.
    const form = new FormData()
    form.append('file', new Blob([buf], { type: 'video/mp4' }), `${p.ad_id}.mp4`)
    form.append('model', 'whisper-1')
    form.append('response_format', 'verbose_json')   // includes word-level timestamps + segments
    form.append('language', 'en')

    const wRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: form,
    })
    if (!wRes.ok) {
      const errBody = await wRes.text()
      throw new Error(`whisper HTTP ${wRes.status}: ${errBody.slice(0, 200)}`)
    }
    const wJson = await wRes.json()
    const fullText = (wJson.text || '').trim()
    const segments = (wJson.segments || []).map(s => ({ t0: s.start, t1: s.end, text: s.text.trim() }))

    if (!fullText) {
      console.warn(`[transcribe] ${p.ad_id} (${p.video_id}): empty transcript, skipping`)
      errors++
      continue
    }

    // Upsert into library.creative_transcripts via lib_* view (or direct? lib_* is a view, needs writable view OR direct table)
    const { error: upErr } = await supabase
      .from('lib_creative_transcripts')   // NOTE: writable through the public view if RLS + grants allow
      .upsert({
        ad_id: p.ad_id,
        meta_video_id: p.video_id,
        source: 'whisper_api',
        language: 'en',
        full_text: fullText,
        segments,
        duration_sec: Math.round(p.length || wJson.duration || 0),
        confidence: null,
      }, { onConflict: 'ad_id,source' })
    if (upErr) {
      console.error(`[transcribe] ${p.ad_id} upsert error:`, upErr.message)
      errors++
      continue
    }
    done++
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`[transcribe] ${done}/${slice.length} ad=${p.ad_id} dur=${p.length?.toFixed(1)}s text="${fullText.slice(0, 80)}..." (${elapsed}s)`)
  } catch (e) {
    errors++
    console.error(`[transcribe] ${p.ad_id} failed:`, e.message)
  } finally {
    try { unlinkSync(tmpPath) } catch {}
  }
}

console.log(`\n[transcribe] DONE — ${done} transcribed, ${errors} errors, ${((Date.now() - startedAt) / 1000).toFixed(1)}s total`)
console.log(`[transcribe] re-run to process the next ${Math.min(MAX_RUN, todo.length - done)} videos`)
