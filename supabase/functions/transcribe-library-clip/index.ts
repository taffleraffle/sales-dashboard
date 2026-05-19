// transcribe-library-clip — Supabase Edge Function
//
// Transcribes a creative-library clip that's been uploaded to Supabase
// Storage (creative-uploads bucket), and writes the resulting text back
// into lib_creative_library.transcript on the matching row.
//
// Body: { library_id: string (uuid), storage_path: string }
// Returns: { ok: true, transcript_preview, duration_sec, segments_count }
//
// Modeled on transcribe-uploaded-ad but writes to a different table
// (the creative library row directly, not lib_creative_transcripts).
//
// Triggered from the UploadModal in /sales/ads/creative/library after
// the file lands in storage and a library row has been created.

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
const BUCKET = 'creative-uploads'

serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors
  const corsHeaders = getCorsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  if (!OPENAI_KEY) return json({ error: 'OPENAI_API_KEY not set in Supabase secrets' }, 500)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'invalid JSON body' }, 400) }
  const libraryId = body?.library_id
  const storagePath = body?.storage_path
  if (!libraryId || typeof libraryId !== 'string') return json({ error: 'library_id required (string)' }, 400)
  if (!storagePath || typeof storagePath !== 'string') return json({ error: 'storage_path required (string)' }, 400)

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // 1. Download from Storage
  const dl = await supabase.storage.from(BUCKET).download(storagePath)
  if (dl.error) return json({ error: `storage download: ${dl.error.message}` }, 502)
  const buf = new Uint8Array(await dl.data.arrayBuffer())

  // Whisper API caps the request payload at 25MB. Anything bigger gets a
  // 413 from OpenAI; surface a clear error to the caller so the row can
  // be flagged rather than silently leaving transcript empty.
  const WHISPER_MAX_BYTES = 24 * 1024 * 1024
  if (buf.byteLength > WHISPER_MAX_BYTES) {
    const note = `Skipped transcription: file is ${Math.round(buf.byteLength / 1e6)}MB (Whisper API cap is 25MB). Trim or compress and re-upload to transcribe.`
    await supabase.from('lib_creative_library')
      .update({ notes: note })
      .eq('id', libraryId)
    return json({
      ok: false,
      error: `file too large for Whisper (${Math.round(buf.byteLength / 1e6)}MB > 25MB)`,
      library_id: libraryId,
    }, 413)
  }

  // 2. Whisper — same params as transcribe-uploaded-ad
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'video/mp4' }), `${libraryId}.mp4`)
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

  // 3. Update the library row with transcript + duration
  const patch: Record<string, unknown> = { transcript: fullText }
  if (wJson.duration) patch.duration_seconds = Math.round(wJson.duration)
  const up = await supabase.from('lib_creative_library').update(patch).eq('id', libraryId)
  if (up.error) return json({ error: `library update: ${up.error.message}` }, 500)

  return json({
    ok: true,
    library_id: libraryId,
    transcript_preview: fullText.slice(0, 200),
    duration_sec: Math.round(wJson.duration || 0),
    full_length: fullText.length,
  })
})
