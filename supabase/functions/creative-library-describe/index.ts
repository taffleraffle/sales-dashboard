// creative-library-describe — Supabase Edge Function
//
// For each lib_creative_library row in the input list, reads the
// transcript (if any) and calls Claude Haiku 4.5 to produce:
//   - messaging_angle: 4-10 word UPPERCASE-KEBAB phrase capturing the
//                      actual pitch / promise / hook of the clip.
//                      Examples: "STOP-PAYING-FOR-LEADS",
//                                "RANKING-GUARANTEED-IN-90-DAYS",
//                                "30-JOBS-IN-FIRST-MONTH".
//   - description:     one short human-readable sentence.
//
// The row's display_name (new, post-migration 103) is built as:
//   {TYPE}-{OFFER}-{MESSAGING}-{ACTOR}-T{NN}.{ext}
//   e.g. BODY-ACCOUNTANT-STOP-PAYING-FOR-LEADS-OSO-T01.mp4
//
// Where:
//   TYPE       = prefixFor(row) — RAW / HOOK / BODY / JOINED / FULL / TESTI
//   OFFER      = upper(offers.slug FK) or 'UNCLASSIFIED'
//   MESSAGING  = messaging_angle_override ?? messaging_angle (AI)
//   ACTOR      = creator (+ '-' + second_creator if set, for JOINED clips)
//   TAKE       = count(*) over (offer_slug, messaging_angle, creator) + 1
//                (recomputed every describe run for stability)
//   ext        = derived from preview_url (.mp4 / .mov / .jpg / .png / ...)
//
// canonical_name is ALSO updated to match display_name for backwards-compat
// during the transition window (any UI surface that reads canonical_name
// directly will still see a sensible string).
//
// Body: { library_ids: string[] }  (UUIDs)
// Returns: { ok, updated: N, errors: [...], rows: [...] }

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

// Build the TYPE prefix from row state. Raw rows always get 'RAW' regardless
// of editorial type, matching the existing convention.
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

// Slug helper for OFFER + ACTOR tokens — uppercase, alphanumerics only, NO
// hyphens (they reserve as our token separator). No truncation.
function tokenSlug(s: string | null | undefined, fallback = 'UNK'): string {
  const cleaned = (s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '')
  return cleaned || fallback
}

// Slug helper for MESSAGING — uppercase, hyphens allowed BETWEEN words
// (the messaging slot is the one place where multi-word kebab is the
// expected shape). No truncation.
function messagingSlug(s: string | null | undefined): string {
  if (!s) return 'UNCLASSIFIED'
  const cleaned = String(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')   // any run of non-alnum -> single hyphen
    .replace(/^-+|-+$/g, '')        // trim leading / trailing hyphens
    .replace(/-{2,}/g, '-')         // collapse multi-hyphens (belt + braces)
  return cleaned || 'UNCLASSIFIED'
}

// Pull the file extension from a URL. Falls back to .mp4 for videos and
// .jpg for images based on type heuristics. The bug we're fixing: the old
// generator hard-coded .mp4 even for image rows.
function extFromUrl(url: string | null | undefined, isImage: boolean): string {
  if (url) {
    const m = url.match(/\.([a-z0-9]{2,5})(\?|$)/i)
    if (m) return '.' + m[1].toLowerCase()
  }
  return isImage ? '.jpg' : '.mp4'
}

function isVideoUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return /\.(mp4|mov|m4v|webm|mkv|avi)(\?|$)/i.test(url)
}

function isImageUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return /\.(jpe?g|png|webp|gif|heic|heif)(\?|$)/i.test(url)
}

// Look up the offer's slug for the filename. Reads the `offers` table by
// the row's offer_slug FK. Returns UPPERCASE slug or 'UNCLASSIFIED'.
async function offerTokenFor(supabase: any, offerSlug: string | null): Promise<string> {
  if (!offerSlug) return 'UNCLASSIFIED'
  const { data, error } = await supabase
    .from('offers')
    .select('slug, name')
    .eq('slug', offerSlug)
    .maybeSingle()
  if (error || !data) return tokenSlug(offerSlug)
  // Prefer the offer's name (more readable: "ACCOUNTANT" vs "opt-accountant")
  // — strip common prefixes the UI strips at render time.
  const raw = String(data.name || data.slug || '')
    .replace(/^opt[-_\s]+/i, '')
    .replace(/[-_\s]+stub$/i, '')
    .replace(/[-_\s]+template$/i, '')
  return tokenSlug(raw)
}

// Compute the take number: count of OTHER rows in the same
// (offer_slug, messaging_angle, creator) bucket + 1. Stable + monotone:
// re-running describe on the same row gives the same number because the
// row itself is excluded from the count.
// Count sibling rows in the same DISPLAY bucket (the one that ends up in
// the filename). The display bucket key is (offer_slug, displayed-angle,
// creator) where displayed-angle = COALESCE(messaging_angle_override,
// messaging_angle). Matching what the caller computed as `displayedAngle`
// avoids the case where an overridden row gets counted against the wrong
// AI bucket and collides with another override row at the same take.
async function takeNumberFor(
  supabase: any,
  rowId: string,
  offerSlug: string | null,
  displayedAngle: string,
  creator: string,
): Promise<number> {
  // Pull ID + the two angle columns for OTHER rows in this offer+creator
  // bucket, then compute the displayed-angle client-side. PostgREST can't
  // express COALESCE(messaging_angle_override, messaging_angle) in a single
  // .eq() — the count must be done in two steps.
  const q = supabase.from('lib_creative_library')
    .select('id, messaging_angle, messaging_angle_override')
    .neq('id', rowId)
    .eq('creator', creator)
  if (offerSlug == null) q.is('offer_slug', null)
  else q.eq('offer_slug', offerSlug)
  const { data, error } = await q
  if (error) return 1
  const matching = (data || []).filter((r: any) => {
    const theirAngle = messagingSlug(r.messaging_angle_override || r.messaging_angle)
    return theirAngle === displayedAngle
  })
  return matching.length + 1
}

async function describeOne(row: any): Promise<{ messaging_angle: string, description: string } | null> {
  const transcript = (row.transcript || '').trim()
  const visualDesc = (row.visual_description || '').trim()
  const isVideo = isVideoUrl(row.preview_url)
  // Video rows MUST be described from the transcript. Falling back to the
  // thumbnail-derived visual_description produced garbage like "fashion
  // styling" on restoration sales clips because Whisper had failed silently
  // (>25 MB cap, no speech track, etc.). If a video has no transcript,
  // skip describe entirely; the operator will hand-label.
  if (isVideo && !transcript) return null
  if (!transcript && !visualDesc) return null
  const truncated = transcript.length > 4000 ? transcript.slice(0, 4000) + '...' : transcript

  const sourceBlock = transcript
    ? `TRANSCRIPT:\n"""\n${truncated}\n"""${visualDesc ? `\n\nVISUAL DESCRIPTION:\n"""\n${visualDesc}\n"""` : ''}`
    : `VISUAL DESCRIPTION (no audio — static image):\n"""\n${visualDesc}\n"""`

  const prompt = `You are reviewing a single short-form ad clip (UGC, hook, body, or full script).

${sourceBlock}

Return JSON with exactly two fields:
  messaging_angle  - The CORE PROMISE / PITCH / HOOK of the clip, expressed as
                     4 to 10 UPPERCASE words separated by single HYPHENS
                     (kebab-case). This is the EXACT thing being said, not
                     a category. Be specific and bulletproof — if two clips
                     pitch different promises, their messaging_angle values
                     MUST be different. Examples:
                       "STOP-PAYING-GOOGLE-FOR-LEADS"
                       "RANKING-GUARANTEED-IN-90-DAYS"
                       "30-JOBS-IN-FIRST-MONTH-OR-FREE"
                       "AI-BOOKS-YOUR-LEADS-WHILE-YOU-SLEEP"
                       "STOP-WASTING-MONEY-ON-FAKE-LEADS"
                     Avoid generic categories like "LEAD-GENERATION" or
                     "SALES-PITCH" — capture the SPECIFIC angle.

  description      - One short sentence (max 90 chars) describing what the
                     clip is about. Plain language. No filler like "this
                     clip is about" or "the speaker says".

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
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`anthropic HTTP ${res.status}: ${errBody.slice(0, 200)}`)
  }
  const json = await res.json()
  const text = json?.content?.[0]?.text || ''
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error(`no JSON in response: ${text.slice(0, 200)}`)
  const parsed = JSON.parse(m[0])
  return {
    messaging_angle: messagingSlug(parsed.messaging_angle),
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

  // Pull all target rows including the new naming overhaul columns.
  const { data: rows, error: selErr } = await supabase
    .from('lib_creative_library')
    .select(`
      id, name, canonical_name, display_name,
      creator, second_creator, offer_slug, type, status,
      messaging_angle, messaging_angle_override,
      transcript, visual_description, preview_url
    `)
    .in('id', ids)
  if (selErr) return json({ error: `select: ${selErr.message}` }, 500)

  const results: any[] = []
  const errors: any[] = []
  let updated = 0

  for (const row of rows || []) {
    try {
      const out = await describeOne(row)
      if (!out) {
        results.push({ id: row.id, skipped: 'video without transcript' })
        continue
      }

      // 1. OFFER token from the offers FK (or UNCLASSIFIED fallback).
      const offerToken = await offerTokenFor(supabase, row.offer_slug)

      // 2. MESSAGING token: prefer human override, else use the AI value
      //    we just generated. Override-priority means the coordinator's
      //    edits survive every re-describe run.
      const angleForName = messagingSlug(row.messaging_angle_override || out.messaging_angle)

      // 3. ACTOR token. For JOINED clips with a second_creator, concat both.
      const primaryActor = tokenSlug(row.creator, 'UNK')
      const secondActor = row.second_creator ? tokenSlug(row.second_creator) : null
      const actorToken = secondActor ? `${primaryActor}-${secondActor}` : primaryActor

      // 4. TAKE number — count siblings in the SAME bucket the display_name
      //    will live in. That's the override bucket when an override exists,
      //    NOT the raw AI bucket. Counting the AI bucket would let two
      //    override rows collide on take number when the AI was identical
      //    but the human override differed.
      const takeNum = await takeNumberFor(supabase, row.id, row.offer_slug, angleForName, row.creator || 'UNK')
      const takeStr = `-T${String(takeNum).padStart(2, '0')}`

      // 5. Extension — derive from preview_url, fall back by media kind.
      const isImage = isImageUrl(row.preview_url) || (!isVideoUrl(row.preview_url) && row.type === 'Image')
      const ext = extFromUrl(row.preview_url, isImage)

      // 6. TYPE prefix.
      const prefix = prefixFor(row)

      // 7. Build display_name. No truncation. Slot separators are single
      //    hyphens; the messaging slot itself contains internal hyphens
      //    (multi-word). This is intentional — the position of TYPE / OFFER
      //    at the head and -T{NN}.{ext} at the tail makes it parseable.
      const displayName = `${prefix}-${offerToken}-${angleForName}-${actorToken}${takeStr}${ext}`

      // Write the new fields. Also update canonical_name to mirror display_name
      // during the transition window so any UI surface that still reads
      // canonical_name directly sees a sensible string. (Once the UI fully
      // migrates to display_name, this can stop.)
      const patch: any = {
        display_name: displayName,
        canonical_name: displayName,
        messaging_angle: out.messaging_angle,
        take_number: takeNum,
        description: out.description,
      }

      const { error: upErr } = await supabase.from('lib_creative_library').update(patch).eq('id', row.id)
      if (upErr) { errors.push({ id: row.id, error: upErr.message }); continue }

      results.push({
        id: row.id,
        messaging_angle: out.messaging_angle,
        description: out.description,
        offer_token: offerToken,
        actor_token: actorToken,
        take_number: takeNum,
        new_display_name: displayName,
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
