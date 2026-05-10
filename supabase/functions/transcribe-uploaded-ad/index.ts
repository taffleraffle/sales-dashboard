// transcribe-uploaded-ad — Supabase Edge Function
//
// C3 path: operator uploads source MP4 for a specific ad to the
// `ad-source-videos` Storage bucket, then this function:
//   1. Downloads the file from Storage
//   2. Transcribes via OpenAI Whisper
//   3. Upserts into library.creative_transcripts with ad_id linked
//
// Body: { ad_id: string, storage_path: string }
// Returns: { ok: true, transcript_preview, duration_sec, segments_count }
//
// This is the high-value path: per-ad spoken transcripts -> phrase scoring
// can now weight by close-rate per spoken hook.

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

const OPENAI_KEY   = Deno.env.get('OPENAI_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const BUCKET = 'ad-source-videos'

serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors
  const corsHeaders = getCorsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  if (!OPENAI_KEY) return json({ error: 'OPENAI_API_KEY not set in Supabase secrets' }, 500)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'invalid JSON body' }, 400) }
  const adId = body?.ad_id
  const storagePath = body?.storage_path
  if (!adId || typeof adId !== 'string') return json({ error: 'ad_id required (string)' }, 400)
  if (!storagePath || typeof storagePath !== 'string') return json({ error: 'storage_path required (string)' }, 400)

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // 1. Download MP4 from Storage
  const dl = await supabase.storage.from(BUCKET).download(storagePath)
  if (dl.error) return json({ error: `storage download: ${dl.error.message}` }, 502)
  const blob = dl.data
  const buf = new Uint8Array(await blob.arrayBuffer())

  // 2. Whisper
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'video/mp4' }), `${adId}.mp4`)
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
    return json({ error: `whisper HTTP ${wRes.status}: ${errBody.slice(0, 300)}` }, 502)
  }
  const wJson = await wRes.json()
  const fullText = (wJson.text || '').trim()
  if (!fullText) return json({ error: 'empty transcript' }, 502)
  const segments = (wJson.segments || []).map((s: any) => ({
    t0: s.start, t1: s.end, text: s.text.trim(),
  }))

  // 3. Upsert into library.creative_transcripts with ad_id linked
  const up = await supabase.from('lib_creative_transcripts').upsert({
    ad_id: adId,
    source: 'whisper_api',
    language: 'en',
    full_text: fullText,
    segments,
    duration_sec: Math.round(wJson.duration || 0),
  }, { onConflict: 'ad_id,source' })
  if (up.error) return json({ error: `upsert: ${up.error.message}` }, 500)

  return json({
    ok: true,
    ad_id: adId,
    transcript_preview: fullText.slice(0, 200),
    duration_sec: Math.round(wJson.duration || 0),
    segments_count: segments.length,
    full_length: fullText.length,
  })
})
