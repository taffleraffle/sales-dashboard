// identify-actor — Supabase Edge Function
//
// For each lib_creative_library row, sends the thumbnail_url image to
// Claude Vision and asks:
//   1) describe the main person visible
//   2) pick the best match from the list of known OPT creators by
//      comparing the target image against ONE reference thumbnail per
//      known creator (sampled from existing library rows where
//      creator IS NOT NULL).
//
// Writes the chosen creator + a short visual_description back to the
// row. If no person is visible (e.g. screencast), creator stays UNK
// and visual_description gets the description anyway so search still
// works.
//
// Body: { library_ids: string[] }
// Returns: { ok, updated: N, errors: [...], rows: [{ id, creator, description, confidence }] }

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
// Sonnet has vision; Haiku 4.5 also supports vision and is cheaper.
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL') || 'claude-haiku-4-5-20251001'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Brand-funnel labels — NOT people, skip face-matching for these so
// Claude doesn't try to match a plumber stock photo to a known actor.
const NON_PERSON_LABELS = new Set(['MAKEUGC', 'PLUMBERS', 'TRADIES', 'ELECTRICIANS', 'ROOFERS', 'PROJECT2', 'UNK'])

async function fetchAsBase64(url: string): Promise<{ data: string, mediaType: string } | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
    const data = btoa(bin)
    // Anthropic Messages API only accepts jpeg/png/gif/webp. Anything else
    // (image/heic from iOS, video/mp4 from a Supabase video URL, missing
    // header, etc.) gets a 400. Normalise the content-type to one of the
    // four accepted values — fall back to jpeg which is the most common.
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    const mediaType = ct.includes('png') ? 'image/png'
      : ct.includes('webp') ? 'image/webp'
      : ct.includes('gif')  ? 'image/gif'
      : 'image/jpeg'
    return { data, mediaType }
  } catch { return null }
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

  // 1. Pull the rows we need to identify
  const { data: targets, error: selErr } = await supabase
    .from('lib_creative_library')
    .select('id, name, canonical_name, creator, type, thumbnail_url')
    .in('id', ids)
  if (selErr) return json({ error: `select: ${selErr.message}` }, 500)

  // 2. Build the reference set — one thumbnail per known PERSON creator.
  //    We pick the most-recently-added row per creator so the reference
  //    image is reasonably representative.
  const { data: candidates } = await supabase
    .from('lib_creative_library')
    .select('creator, thumbnail_url, added_at')
    .not('creator', 'is', null)
    .not('thumbnail_url', 'is', null)
    .order('added_at', { ascending: false })
    .limit(500)
  const refByCreator = new Map<string, string>()
  for (const r of candidates || []) {
    const c = String(r.creator || '').toUpperCase()
    if (!c || NON_PERSON_LABELS.has(c)) continue
    if (!refByCreator.has(c)) refByCreator.set(c, r.thumbnail_url as string)
  }
  const refList = Array.from(refByCreator.entries())
  // Pre-fetch reference images once (shared across all target calls)
  const refImages: { name: string, image: { data: string, mediaType: string } }[] = []
  for (const [name, url] of refList) {
    const img = await fetchAsBase64(url)
    if (img) refImages.push({ name, image: img })
  }

  const results: any[] = []
  const errors: any[] = []
  let updated = 0

  for (const row of targets || []) {
    if (!row.thumbnail_url) {
      results.push({ id: row.id, skipped: 'no thumbnail' })
      continue
    }
    try {
      const target = await fetchAsBase64(row.thumbnail_url as string)
      if (!target) {
        errors.push({ id: row.id, error: 'thumbnail fetch failed' })
        continue
      }
      // Build a multi-image prompt: target first, then each reference.
      const referenceNames = refImages.map(r => r.name)
      const content: any[] = []
      content.push({ type: 'text', text: 'Target frame:' })
      content.push({ type: 'image', source: { type: 'base64', media_type: target.mediaType, data: target.data } })
      if (refImages.length > 0) {
        content.push({ type: 'text', text: 'Reference frames — one per known person, each labelled before the image:' })
        // Label each reference image immediately before pushing it so
        // Claude can match by labelled reference rather than position in
        // a comma list. Standard multi-image labelling pattern.
        for (const r of refImages) {
          content.push({ type: 'text', text: `Reference: ${r.name}` })
          content.push({ type: 'image', source: { type: 'base64', media_type: r.image.mediaType, data: r.image.data } })
        }
      }
      content.push({ type: 'text', text:
`You compare ad-creative video stills. Look at the TARGET frame and decide:
1. Is there a clearly visible person?
2. If yes, which of the REFERENCE people (if any) is the same person as the target?
3. Otherwise return UNKNOWN.

Available references: ${referenceNames.join(', ') || '(none)'}.

Return JSON ONLY:
{
  "description": "one-line visual description of the target frame (person + setting, ~80 chars)",
  "best_match": "EXACT_NAME_FROM_REFERENCES or UNKNOWN or NO_PERSON",
  "confidence": 0.0-1.0
}

Use NO_PERSON if the target frame is a screencast / black screen / logo card with no human.
Use UNKNOWN if there's a person but they don't clearly match any reference.
Only return a reference name when you are confident (>0.7).` })

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 300,
          messages: [{ role: 'user', content }],
        }),
      })
      if (!res.ok) {
        const errBody = await res.text()
        errors.push({ id: row.id, error: `anthropic HTTP ${res.status}: ${errBody.slice(0, 200)}` })
        continue
      }
      const aiJson = await res.json()
      const text = aiJson?.content?.[0]?.text || ''
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) {
        errors.push({ id: row.id, error: `no JSON in response: ${text.slice(0, 200)}` })
        continue
      }
      const parsed = JSON.parse(m[0])
      const description = String(parsed.description || '').trim().slice(0, 200)
      const matchRaw = String(parsed.best_match || '').toUpperCase().trim()
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0))

      // Only apply a match if Claude is confident AND the name is in
      // our reference set. NO_PERSON / UNKNOWN leave the row's existing
      // creator alone.
      let newCreator: string | null = null
      if (matchRaw && matchRaw !== 'UNKNOWN' && matchRaw !== 'NO_PERSON' && confidence >= 0.7) {
        if (referenceNames.includes(matchRaw)) newCreator = matchRaw
      }

      const patch: any = { visual_description: description }
      if (newCreator) patch.creator = newCreator
      const { error: upErr } = await supabase.from('lib_creative_library')
        .update(patch).eq('id', row.id)
      if (upErr) { errors.push({ id: row.id, error: upErr.message }); continue }

      results.push({
        id: row.id,
        creator: newCreator || row.creator,
        match_raw: matchRaw,
        confidence,
        description,
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
    reference_creators: Array.from(refByCreator.keys()),
  })
})
