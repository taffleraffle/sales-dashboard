// transcribe-ads — Supabase Edge Function
//
// Pivot 2026-05-11: Meta restricts the `source` URL for ad-creative videos
// (creative.video_id range), so we cannot download the exact videos used in
// running ads. We CAN download videos from the account's `/advideos` library
// (the upload catalog). These two catalogs share no IDs but contain the
// same underlying creative content uploaded by OPT.
//
// This function transcribes the /advideos catalog as a brand-voice corpus
// (stored with ad_id=NULL, meta_video_id=advideo.id, source='whisper_api').
// The corpus feeds the analyst's "next wave" prompt and is searchable for
// "what has OPT actually said on camera." Per-ad attribution would require
// manual MP4 uploads (deferred — option C3 in the plan).
//
// Incremental: only transcribes advideos not already in
// library.creative_transcripts (dedupe via meta_video_id). Caps each invocation
// at maxRun videos to stay under the 60s wall-clock limit.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALLOWED_ORIGINS = [
  'https://sales-dashboard-ftct.onrender.com',
  'http://localhost:5173',
  'http://localhost:4173',
]
function getCorsHeaders(req?: Request): Record<string, string> {
  const origin = req?.headers?.get('origin') || ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  }
}
function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) })
  return null
}

const OPENAI_KEY    = Deno.env.get('OPENAI_API_KEY')
const META_ACCOUNT  = Deno.env.get('META_ADS_ACCOUNT_ID')
const META_TOKEN    = Deno.env.get('META_ADS_ACCESS_TOKEN')
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors
  const corsHeaders = getCorsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  if (!OPENAI_KEY) return json({ error: 'OPENAI_API_KEY not set in Supabase secrets' }, 500)
  if (!META_ACCOUNT || !META_TOKEN) return json({ error: 'Meta credentials not set in Supabase secrets' }, 500)

  let maxRun = 25
  try {
    const body = await req.json().catch(() => ({}))
    if (typeof body.maxRun === 'number') maxRun = Math.min(Math.max(1, body.maxRun), 100)
  } catch { /* empty body fine */ }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // 1. Pull advideos catalog (paginate)
  type Advideo = { id: string; source: string; length: number; title: string }
  const catalog: Advideo[] = []
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
      if (v.id && v.source) catalog.push({ id: v.id, source: v.source, length: v.length || 0, title: v.title || '' })
    }
    url = j.paging?.next || ''
  }

  // 2. Dedupe: filter to advideos we haven't transcribed yet
  const doneRes = await supabase.from('lib_creative_transcripts')
    .select('meta_video_id').eq('source', 'whisper_api').not('meta_video_id', 'is', null)
  if (doneRes.error) return json({ error: `transcript read: ${doneRes.error.message}` }, 500)
  const done = new Set((doneRes.data || []).map((r: any) => r.meta_video_id))
  const todo = catalog.filter(v => !done.has(v.id)).slice(0, maxRun)

  if (todo.length === 0) {
    return json({ ok: true, processed: 0, errors: 0, totalPending: 0, catalogSize: catalog.length, message: 'All advideos already transcribed.' })
  }

  // 3. Download + Whisper + upsert
  let processed = 0
  let errors = 0
  const startedAt = Date.now()
  const errorDetails: string[] = []
  for (const v of todo) {
    try {
      const dl = await fetch(v.source)
      if (!dl.ok) throw new Error(`video download HTTP ${dl.status}`)
      const buf = new Uint8Array(await dl.arrayBuffer())

      const form = new FormData()
      form.append('file', new Blob([buf], { type: 'video/mp4' }), `${v.id}.mp4`)
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
      if (!fullText) { errors++; errorDetails.push(`${v.id}: empty transcript`); continue }
      const segments = (wJson.segments || []).map((s: any) => ({
        t0: s.start, t1: s.end, text: s.text.trim(),
      }))

      const up = await supabase.from('lib_creative_transcripts').insert({
        ad_id: null,
        variant_id: null,
        meta_video_id: v.id,
        source: 'whisper_api',
        language: 'en',
        full_text: fullText,
        segments,
        duration_sec: Math.round(v.length || wJson.duration || 0),
      })
      if (up.error) {
        errors++
        errorDetails.push(`${v.id}: ${up.error.message}`)
        continue
      }
      processed++
    } catch (e) {
      errors++
      errorDetails.push(`${v.id}: ${(e as Error).message}`)
    }
    if (Date.now() - startedAt > 50_000) break
  }

  const remainingRes = await supabase.from('lib_creative_transcripts')
    .select('meta_video_id').eq('source', 'whisper_api').not('meta_video_id', 'is', null)
  const newDone = new Set((remainingRes.data || []).map((r: any) => r.meta_video_id))
  const totalPending = catalog.filter(v => !newDone.has(v.id)).length

  return json({
    ok: true,
    processed,
    errors,
    totalPending,
    catalogSize: catalog.length,
    elapsedSec: ((Date.now() - startedAt) / 1000).toFixed(1),
    errorDetails: errorDetails.slice(0, 5),  // first 5 errors only
  })
})
