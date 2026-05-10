// transcribe-ads — Supabase Edge Function
//
// Downloads Meta ad videos and transcribes them via OpenAI Whisper, then
// upserts the result into library.creative_transcripts as source='whisper_api'.
//
// Called by the dashboard's "Transcribe videos" button on /sales/ads/gallery.
// Runs incrementally — only transcribes ads that don't already have a
// whisper_api transcript. Caps each invocation at `maxRun` (default 25) so a
// single invocation stays under Edge Function 60s wall-clock limit.
//
// Secrets required in Supabase project:
//   - OPENAI_API_KEY            OpenAI API key (Whisper access)
//   - META_ADS_ACCOUNT_ID       Meta ad account id
//   - META_ADS_ACCESS_TOKEN     Meta long-lived token
//   - SUPABASE_URL              (auto-provided by Supabase)
//   - SUPABASE_SERVICE_ROLE_KEY (auto-provided by Supabase)
//
// Body: { maxRun?: number }    — default 25
// Returns: { ok: true, processed, errors, totalPending }

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { handleCors, getCorsHeaders } from '../_shared/cors.ts'

const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY')
const META_ACCOUNT = Deno.env.get('META_ADS_ACCOUNT_ID')
const META_TOKEN = Deno.env.get('META_ADS_ACCESS_TOKEN')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors
  const corsHeaders = getCorsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  if (!OPENAI_KEY) return json({ error: 'OPENAI_API_KEY not set in Supabase secrets' }, 500)
  if (!META_ACCOUNT || !META_TOKEN) return json({ error: 'Meta credentials not set in Supabase secrets' }, 500)

  let maxRun = 25
  try {
    const body = await req.json().catch(() => ({}))
    if (typeof body.maxRun === 'number') maxRun = Math.min(Math.max(1, body.maxRun), 100)
  } catch { /* empty body fine */ }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // ── 1. Pull video catalog from Meta (id → source URL)
  const videoMap = new Map<string, { source: string; length: number; title: string }>()
  let url = `https://graph.facebook.com/v21.0/act_${META_ACCOUNT}/advideos?` + new URLSearchParams({
    access_token: META_TOKEN,
    fields: 'id,title,source,length',
    limit: '200',
  }).toString()

  while (url) {
    const res = await fetch(url)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return json({ error: `Meta advideos error: ${err.error?.message || res.statusText}` }, 502)
    }
    const j = await res.json()
    for (const v of j.data || []) {
      if (v.id && v.source) videoMap.set(v.id, { source: v.source, length: v.length || 0, title: v.title || '' })
    }
    url = j.paging?.next || ''
  }

  // ── 2. Join to public.ads.raw_payload.creative.video_id
  const adsRes = await supabase.from('ads')
    .select('ad_id, ad_name, raw_payload, asset_type')
    .eq('asset_type', 'video')
  if (adsRes.error) return json({ error: `ads read: ${adsRes.error.message}` }, 500)

  const pairs: Array<{ ad_id: string; video_id: string; source: string; length: number }> = []
  for (const a of adsRes.data || []) {
    const c: any = a.raw_payload?.creative
    const vid = c?.video_id || c?.object_story_spec?.video_data?.video_id
    if (!vid) continue
    const v = videoMap.get(vid)
    if (!v) continue
    pairs.push({ ad_id: a.ad_id, video_id: vid, source: v.source, length: v.length })
  }

  // ── 3. Filter to ads without an existing whisper_api transcript
  const doneRes = await supabase.from('lib_creative_transcripts')
    .select('ad_id').eq('source', 'whisper_api')
  if (doneRes.error) return json({ error: `transcript read: ${doneRes.error.message}` }, 500)
  const done = new Set((doneRes.data || []).map((r: any) => r.ad_id))
  const todo = pairs.filter((p) => !done.has(p.ad_id)).slice(0, maxRun)

  if (todo.length === 0) {
    return json({ ok: true, processed: 0, errors: 0, totalPending: 0, message: 'All video ads already transcribed.' })
  }

  // ── 4. For each: download video, call Whisper, upsert transcript
  let processed = 0
  let errors = 0
  const startedAt = Date.now()
  for (const p of todo) {
    try {
      const dl = await fetch(p.source)
      if (!dl.ok) throw new Error(`video download HTTP ${dl.status}`)
      const buf = new Uint8Array(await dl.arrayBuffer())

      const form = new FormData()
      form.append('file', new Blob([buf], { type: 'video/mp4' }), `${p.ad_id}.mp4`)
      form.append('model', 'whisper-1')
      form.append('response_format', 'verbose_json')
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
      if (!fullText) {
        errors++
        continue
      }
      const segments = (wJson.segments || []).map((s: any) => ({
        t0: s.start, t1: s.end, text: s.text.trim(),
      }))

      const up = await supabase.from('lib_creative_transcripts').upsert({
        ad_id: p.ad_id,
        meta_video_id: p.video_id,
        source: 'whisper_api',
        language: 'en',
        full_text: fullText,
        segments,
        duration_sec: Math.round(p.length || wJson.duration || 0),
      }, { onConflict: 'ad_id,source' })
      if (up.error) {
        console.error('upsert error', p.ad_id, up.error.message)
        errors++
      } else {
        processed++
      }
    } catch (e) {
      console.error('transcribe error', p.ad_id, (e as Error).message)
      errors++
    }
    // Edge Functions have a 60s wall-clock. Bail if we're close.
    if (Date.now() - startedAt > 50_000) break
  }

  // ── 5. Total pending (so the UI can show how much is left)
  const remainingRes = await supabase.from('lib_creative_transcripts')
    .select('ad_id').eq('source', 'whisper_api')
  const newDone = new Set((remainingRes.data || []).map((r: any) => r.ad_id))
  const totalPending = pairs.filter((p) => !newDone.has(p.ad_id)).length

  return json({
    ok: true,
    processed,
    errors,
    totalPending,
    elapsedSec: ((Date.now() - startedAt) / 1000).toFixed(1),
  })
})
