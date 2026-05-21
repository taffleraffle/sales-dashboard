// creative-library-describe — Supabase Edge Function
//
// For each lib_creative_library row in the input list, reads the
// transcript (if any) and calls Claude Haiku 4.5 to produce:
//   - topic_short:  2-4 word slug (will become the canonical-name "slot")
//   - description:  one-line human-readable description
//
// The row's canonical_name is rebuilt as:
//   <PREFIX>-<CREATOR>-<TOPIC>-T<NN>.mp4
// where PREFIX is RAW / HOOK / BODY / FULL / TESTI based on status+type.
//
// Body: { library_ids: string[] }  (UUIDs)
// Returns: { ok, updated: N, errors: [...], rows: [{ id, topic, description, new_canonical }] }
//
// Designed for one-shot batch ops. Sequential to stay safe on Anthropic
// rate limits + Edge Function CPU budget (150s wall clock).

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

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL') || 'claude-haiku-4-5-20251001'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Build the canonical_name prefix from row state. Raw rows get 'RAW' to
// match the existing naming convention. Edited rows get the type prefix.
function prefixFor(row: any): string {
  if (row.status === 'raw') return 'RAW'
  switch (row.type) {
    case 'Hook':       return 'HOOK'
    case 'Body':       return 'BODY'
    case 'Joined':     return 'JOINED'
    case 'Full Video': return 'FULL'
    case 'Testimony':  return 'TESTI'
    default:           return 'RAW'
  }
}

function slugify(s: string): string {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 16) || 'UNTITLED'
}

async function describeOne(row: any): Promise<{ topic: string, description: string } | null> {
  const transcript = (row.transcript || '').trim()
  const visualDesc = (row.visual_description || '').trim()
  // Two valid inputs: a Whisper transcript (video) OR a visual description
  // from identify-actor (image / silent clip). If neither, skip — there's
  // nothing for Claude to summarise.
  if (!transcript && !visualDesc) return null
  const truncated = transcript.length > 4000 ? transcript.slice(0, 4000) + '...' : transcript

  // Build the source-content block based on what we have. Image rows lean
  // on the visual_description, video rows on the transcript. When both
  // are present (rare but possible), give Claude both.
  const sourceBlock = transcript
    ? `TRANSCRIPT:\n"""\n${truncated}\n"""${visualDesc ? `\n\nVISUAL DESCRIPTION:\n"""\n${visualDesc}\n"""` : ''}`
    : `VISUAL DESCRIPTION (no audio — static image or silent clip):\n"""\n${visualDesc}\n"""`

  const prompt = `You are reviewing a single short-form ad clip (UGC, hook, body, or full script).

${sourceBlock}

Return JSON with exactly two fields:
  topic_short  - 2 to 4 UPPERCASE WORDS capturing the central hook/topic.
                 Examples: "TPA SCAM", "STOP ADVERTISING", "40 CALLS PER WEEK",
                 "HAMMER METHOD", "AI CONSULTING".
                 Just the core message — no punctuation, no filler.
  description  - one short sentence (max 90 chars) describing what the
                 clip is about. Plain language. No filler like "this clip
                 is about" or "the speaker says".

Output ONLY the JSON object, no preamble.`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`anthropic HTTP ${res.status}: ${errBody.slice(0, 200)}`)
  }
  const json = await res.json()
  const text = json?.content?.[0]?.text || ''
  // Extract first JSON object from the response
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error(`no JSON in response: ${text.slice(0, 200)}`)
  const parsed = JSON.parse(m[0])
  return {
    topic: String(parsed.topic_short || '').trim(),
    description: String(parsed.description || '').trim(),
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) })
  const cors = getCorsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'invalid JSON body' }, 400) }
  const ids: string[] = Array.isArray(body?.library_ids) ? body.library_ids : []
  if (ids.length === 0) return json({ error: 'library_ids array required' }, 400)

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // Pull all target rows — include visual_description so image rows (no
  // transcript) can be summarised from the identify-actor description.
  const { data: rows, error: selErr } = await supabase
    .from('lib_creative_library')
    .select('id, name, canonical_name, creator, type, status, transcript, visual_description')
    .in('id', ids)
  if (selErr) return json({ error: `select: ${selErr.message}` }, 500)

  const results: any[] = []
  const errors: any[] = []
  let updated = 0

  for (const row of rows || []) {
    try {
      const out = await describeOne(row)
      if (!out) {
        results.push({ id: row.id, skipped: 'no transcript' })
        continue
      }
      // Preserve take number if the existing canonical_name has one
      const takeMatch = (row.canonical_name || '').match(/-T(\d{2,})\.[a-z0-9]+$/i)
      const takeStr = takeMatch ? `-T${takeMatch[1]}` : '-T01'
      const ext = '.mp4'
      const prefix = prefixFor(row)
      const creator = (row.creator || 'UNK').toUpperCase().replace(/[^A-Z0-9]/g, '')
      const slot = slugify(out.topic)
      const newCanonical = `${prefix}-${creator}-${slot}${takeStr}${ext}`

      const { error: upErr } = await supabase.from('lib_creative_library').update({
        canonical_name: newCanonical,
        description: out.description,
      }).eq('id', row.id)
      if (upErr) { errors.push({ id: row.id, error: upErr.message }); continue }

      results.push({
        id: row.id,
        topic: out.topic,
        description: out.description,
        new_canonical: newCanonical,
      })
      updated++
    } catch (e: any) {
      errors.push({ id: row.id, error: e?.message || String(e) })
    }
  }

  return json({
    ok: true,
    requested: ids.length,
    updated,
    errors,
    rows: results,
  })
})
