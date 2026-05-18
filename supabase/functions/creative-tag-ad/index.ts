// creative-tag-ad — Supabase Edge Function
//
// Server-side LLM attribute extraction for the Creative Performance Analytics
// module. Reads an ad's transcript + headline + primary text, calls Claude
// with tool-use JSON-mode to extract the 9 LLM-extractable test-variable
// attributes, upserts into public.creative_attributes.
//
// Operator-only attributes (actor, vertical, manual_winner_override) are
// NEVER set by this function — left null/unchanged for manual entry.
//
// Request shapes:
//   { mode: 'one',   ad_id }                  — tag a single ad
//   { mode: 'batch', ad_ids: [...] }          — tag many (concurrency-bounded)
//   { mode: 'missing', limit: 50 }            — tag ads that don't yet have an
//                                               extracted_at row
//
// Response: { ok: true, results: [{ ad_id, attributes, confidence }] }
//
// ANTHROPIC_API_KEY required as Supabase secret.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── CORS ──────────────────────────────────────────────────────────────
// Origin matcher — see creative-parse-doc/index.ts for the rationale.
const PROD_ORIGIN = 'https://sales-dashboard-ftct.onrender.com'
function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false
  if (origin === PROD_ORIGIN) return true
  if (/^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(origin)) return true
  if (/^http:\/\/localhost(:\d+)?$/i.test(origin)) return true
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin)) return true
  return false
}
function getCorsHeaders(req?: Request): Record<string, string> {
  const origin = req?.headers?.get('origin') || ''
  const allowed = isAllowedOrigin(origin) ? origin : PROD_ORIGIN
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

// ── Env ───────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-4-20250514'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// ── System prompt ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a creative-attribute classifier for OPT Digital paid ads.

OPT Digital is a high-ticket lead-gen agency running Meta ads for restoration / plumbing / HVAC / roofing / electrical contractors. The scripts apply Eugene Schwartz Breakthrough Advertising (awareness stages + sophistication levels), Truth-vs-Trust mechanism-led framing, and a structured Message Frame test variable (Problem / Circumstance / Outcome).

You will be given:
1. An ad's headline + primary text from Meta
2. An ad's spoken-creative transcript (Whisper or Meta caption)
3. The controlled vocabulary for each attribute

You will call the set_creative_attributes tool to return a strict JSON object classifying the ad across 9 dimensions. Use ONLY the allowed values from the vocabulary. If an attribute is genuinely ambiguous, set confidence < 0.5 for that field — do not refuse to classify.

CLASSIFICATION RULES:

hook_type (look ONLY at the first 1-2 sentences):
- question: opens with a literal question to the prospect ("How many marketing companies have you fired?")
- scene: paints a specific scene ("Tuesday morning at Adam's mit shop")
- dollar_pain: leads with a specific dollar figure of waste/loss ("Eighteen months of $5k retainers")
- diagnostic: piercing single-line diagnosis ("If your phone rings because of someone else, you don't own your business")
- conditional: if/then frame ("If your phone rang less than five times this week…")

message_frame (the dominant frame across the whole script):
- problem: speaks to active pain — what's broken
- circumstance: speaks to the specific situation the prospect is in right now
- outcome: paints the vivid end-state, scene-paints the after-state

mechanism_reveal:
- gated: brand-named mechanism (e.g. "The Direct Call Engine") without revealing the literal deliverable
- explicit: names the literal deliverable (e.g. "top 3 in Google Maps", "Google Business Profile rebuild")
- hidden: mechanism not named at all — outcomes only

proof_character (who is the named client/case study in this ad — pick exactly ONE):
- eric, adam, belinda, morgan, karen, derek, mike — see vocab
- none if no named proof character

pain_angle (the primary pain angle being targeted — pick the BEST single fit):
- See vocab. Examples: phone_not_ringing, agency_burn, tpa_referral_dep, capacity_mismatch, lead_platform, storm_seasonal, scaling_growth, speed_timeline, guarantee_proof, founder_identity, commercial_tier, adjuster_relations, competitor_takeover, last_objection

funnel_stage:
- tof: cold prospecting (acquaintance language, "you haven't heard of us yet")
- mof: warm retargeting (comparison-aware, "you've been burned before")
- bof: hot retargeting (urgency, objection-handling, money-back specifics)
- cross: explicitly plays at multiple stages

awareness_level (Schwartz 5 stages):
- unaware: doesn't recognize they have a problem
- problem_aware: knows they have a problem, no solution category yet
- solution_aware: knows solutions exist, hasn't picked one
- product_aware: knows OPT specifically
- most_aware: needs deadline + offer, nothing else

length_bucket (compute from duration_sec if provided, else estimate from word count at ~150 wpm):
- under_60s
- sixty_75s
- over_75s

format (from asset metadata + transcript style):
- talking_head: founder/operator on camera, direct address
- ugc: customer or operator-style, less polished
- comparative: side-by-side / comparison format
- voiceover: no on-camera talent, VO only

CONFIDENCE:
For each field return a confidence score 0..1. Be honest:
- 0.9+ = obvious, unambiguous
- 0.7-0.9 = clear with minor ambiguity
- 0.5-0.7 = leaning one way but defensible alternative exists
- <0.5 = genuine guess, operator should override

If you cannot find evidence to classify a field at all (e.g. transcript is empty/garbled), return null for that field and confidence: 0.

Be ruthlessly literal. Do not invent attributes the ad doesn't actually have.`

// ── Helpers ───────────────────────────────────────────────────────────
async function loadVocab(supabase: any): Promise<Record<string, string[]>> {
  const { data, error } = await supabase
    .from('creative_attribute_vocab')
    .select('attribute_name, attribute_value')
    .eq('retired', false)
  if (error) throw new Error(`vocab fetch failed: ${error.message}`)
  const grouped: Record<string, string[]> = {}
  for (const row of data || []) {
    if (!grouped[row.attribute_name]) grouped[row.attribute_name] = []
    grouped[row.attribute_name].push(row.attribute_value)
  }
  return grouped
}

async function loadAdContext(supabase: any, ad_id: string) {
  const [adRes, transRes] = await Promise.all([
    supabase.from('ads')
      .select('ad_id, ad_name, headline, primary_text, description, asset_type, asset_url, thumbnail_url, raw_payload')
      .eq('ad_id', ad_id).maybeSingle(),
    // public.lib_creative_transcripts is a forwarding view over library.creative_transcripts
    // (defined in migration 028) so the public schema is reachable via PostgREST.
    supabase
      .from('lib_creative_transcripts')
      .select('source, full_text, duration_sec')
      .eq('ad_id', ad_id),
  ])
  if (adRes.error) throw new Error(`ad fetch: ${adRes.error.message}`)
  if (!adRes.data) throw new Error(`ad_id ${ad_id} not found in public.ads`)

  // Pick best transcript: whisper_api > whisper_local > meta_caption > ad_copy > manual
  const sourcePriority: Record<string, number> = {
    whisper_api: 5, whisper_local: 4, meta_caption: 3, manual: 2, ad_copy: 1,
  }
  const transcripts = (transRes.data || []).sort(
    (a: any, b: any) => (sourcePriority[b.source] || 0) - (sourcePriority[a.source] || 0)
  )
  const best = transcripts[0]

  return {
    ad: adRes.data,
    transcript: best?.full_text || null,
    transcript_source: best?.source || null,
    duration_sec: best?.duration_sec ?? adRes.data?.raw_payload?.duration ?? null,
  }
}

/**
 * Fetch the image and return base64 + media_type. Used only for image
 * ads (and video posters) — passing Claude the actual image lets it
 * describe what's visually in the creative, not just what the copy says.
 *
 * Returns null on any failure — caller falls back to text-only tagging.
 */
async function fetchImageAsBase64(url: string): Promise<{ data: string, media_type: string } | null> {
  if (!url) return null
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return null
    const ct = res.headers.get('content-type') || 'image/jpeg'
    const media_type = ct.includes('png') ? 'image/png'
      : ct.includes('webp') ? 'image/webp'
      : ct.includes('gif') ? 'image/gif'
      : 'image/jpeg'
    const buf = new Uint8Array(await res.arrayBuffer())
    // Cap at 5MB so the Anthropic API doesn't refuse and we don't burn budget.
    if (buf.length === 0 || buf.length > 5 * 1024 * 1024) return null
    // Base64 encode
    let bin = ''
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
    const data = btoa(bin)
    return { data, media_type }
  } catch (_e) {
    return null
  }
}

function buildToolSchema(vocab: Record<string, string[]>) {
  // Trimmed 2026-05-18: dropped funnel_stage, length_bucket, format,
  // proof_character, actor, vertical from active tagging per operator
  // request. Columns still exist in creative_attributes (and may have
  // historical data) but the LLM no longer extracts them.
  return {
    name: 'set_creative_attributes',
    description: 'Set the test-variable attributes for this ad. Use only values from the provided vocab.',
    input_schema: {
      type: 'object',
      properties: {
        hook_type:        { type: ['string', 'null'], enum: [...(vocab.hook_type || []), null] },
        message_frame:    { type: ['string', 'null'], enum: [...(vocab.message_frame || []), null] },
        mechanism_reveal: { type: ['string', 'null'], enum: [...(vocab.mechanism_reveal || []), null] },
        pain_angle:       { type: ['string', 'null'], enum: [...(vocab.pain_angle || []), null] },
        awareness_level:  { type: ['string', 'null'], enum: [...(vocab.awareness_level || []), null] },
        confidence: {
          type: 'object',
          properties: {
            hook_type:        { type: 'number' },
            message_frame:    { type: 'number' },
            mechanism_reveal: { type: 'number' },
            pain_angle:       { type: 'number' },
            awareness_level:  { type: 'number' },
          },
          required: ['hook_type','message_frame','mechanism_reveal','pain_angle','awareness_level'],
        },
        scene_description: {
          type: ['string', 'null'],
          description: 'For image/video ads: ONE specific sentence describing what is visually in the creative — actors, setting, props, on-screen text. NOT a re-summary of the ad copy. E.g. "Man in black raincoat standing in a flooded city street holding a large yellow sandwich-board sign that reads WATER DAMAGE PROS DOING $50K+/MTH, restoration van with logo in background." Null if no image is available.',
        },
        reasoning: {
          type: 'string',
          description: 'One short paragraph explaining the tag choices. Reference both the visual content (when present) and the copy.',
        },
      },
      required: ['hook_type','message_frame','mechanism_reveal','pain_angle','awareness_level','confidence','reasoning'],
    },
  }
}

async function classifyAd(supabase: any, ad_id: string, vocab: Record<string, string[]>) {
  const ctx = await loadAdContext(supabase, ad_id)
  const tool = buildToolSchema(vocab)

  // Try to pull the actual image bytes for image ads (and video posters).
  // asset_url is the Supabase Storage URL after migration 066, so it
  // doesn't expire. Soft-fails to text-only if anything goes wrong.
  let imageBlock: any = null
  const imageCandidateUrl = ctx.ad?.asset_url || ctx.ad?.thumbnail_url || null
  if (imageCandidateUrl && (ctx.ad?.asset_type === 'image' || ctx.ad?.asset_type === 'video')) {
    const img = await fetchImageAsBase64(imageCandidateUrl)
    if (img) {
      imageBlock = {
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      }
    }
  }

  const textBlock = {
    type: 'text',
    text: [
      `AD ID: ${ad_id}`,
      `AD NAME: ${ctx.ad.ad_name || '(no name)'}`,
      `HEADLINE: ${ctx.ad.headline || '(none)'}`,
      `PRIMARY TEXT: ${ctx.ad.primary_text || '(none)'}`,
      `DESCRIPTION: ${ctx.ad.description || '(none)'}`,
      `ASSET TYPE: ${ctx.ad.asset_type || '(unknown)'}`,
      `DURATION: ${ctx.duration_sec != null ? `${ctx.duration_sec}s` : '(unknown)'}`,
      imageBlock ? '' : 'NOTE: No image available; classify from copy + transcript only.',
      '',
      `TRANSCRIPT (source: ${ctx.transcript_source || 'NONE'}):`,
      ctx.transcript || '(no transcript available)',
      '',
      imageBlock
        ? 'For scene_description: describe what is visually in the attached image — actors, setting, props, on-screen text. Be specific. Do NOT just summarize the copy.'
        : 'No image to describe; set scene_description to null.',
      'Classify this ad. Use only vocab values. Return null for any field you genuinely cannot determine, with confidence 0.',
    ].join('\n'),
  }

  // Image must come BEFORE the text block per Anthropic best-practices
  const content = imageBlock ? [imageBlock, textBlock] : [textBlock]

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
      tools: [tool],
      tool_choice: { type: 'tool', name: 'set_creative_attributes' },
    }),
  })
  if (!upstream.ok) {
    const errText = await upstream.text()
    throw new Error(`Anthropic ${upstream.status}: ${errText.slice(0, 400)}`)
  }
  const result = await upstream.json()
  const toolUse = (result.content || []).find((c: any) => c.type === 'tool_use')
  if (!toolUse) throw new Error('Claude did not return a tool_use block')
  return { attributes: toolUse.input, raw_response: result }
}

async function persist(supabase: any, ad_id: string, classified: { attributes: any, raw_response: any }) {
  const a = classified.attributes
  // Notes get the scene description (when available) followed by the
  // reasoning. The image-specific description goes FIRST so operators
  // see the visual content immediately when reviewing.
  const notesParts = []
  if (a.scene_description) notesParts.push(`SCENE: ${a.scene_description}`)
  if (a.reasoning) notesParts.push(a.reasoning)
  const notes = notesParts.join('\n\n')

  const { error } = await supabase
    .from('creative_attributes')
    .upsert({
      ad_id,
      hook_type: a.hook_type,
      message_frame: a.message_frame,
      mechanism_reveal: a.mechanism_reveal,
      pain_angle: a.pain_angle,
      awareness_level: a.awareness_level,
      // Dropped 2026-05-18: proof_character, funnel_stage, length_bucket, format.
      // Columns still exist on the table for historical data; we just don't
      // overwrite them with the LLM output anymore. Operator can still set
      // them manually via the edit drawer if needed.
      extracted_at: new Date().toISOString(),
      extracted_by_model: ANTHROPIC_MODEL,
      extraction_confidence: a.confidence,
      raw_llm_response: classified.raw_response,
      notes,
    }, { onConflict: 'ad_id' })
  if (error) throw new Error(`upsert creative_attributes: ${error.message}`)
}

// ── Server ────────────────────────────────────────────────────────────
serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
 try {
  const cors = handleCors(req)
  if (cors) return cors

  if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }
  const mode = body?.mode

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  let vocab: Record<string, string[]>
  try { vocab = await loadVocab(supabase) } catch (e: any) { return json({ error: e.message }, 500) }

  // Resolve target ad_ids based on mode
  let ad_ids: string[]
  if (mode === 'one') {
    if (!body.ad_id) return json({ error: 'ad_id required for mode=one' }, 400)
    ad_ids = [body.ad_id]
  } else if (mode === 'batch') {
    if (!Array.isArray(body.ad_ids) || !body.ad_ids.length) return json({ error: 'ad_ids[] required for mode=batch' }, 400)
    ad_ids = body.ad_ids
  } else if (mode === 'missing') {
    // Cap at 50 to stay inside Supabase Edge Function 150s wall-clock
    // (50 ads / concurrency 4 ≈ 13 batches × 5s = 65s — well within).
    const limit = Math.min(body.limit || 25, 50)
    // lib_ads_needing_extraction (mig 060) returns ad_ids that don't have
    // a creative_attributes row OR have one but extracted_at IS NULL.
    const { data, error } = await supabase
      .from('lib_ads_needing_extraction')
      .select('ad_id')
      .limit(limit)
    if (error) return json({ error: error.message }, 500)
    ad_ids = (data || []).map((r: any) => r.ad_id)
  } else {
    return json({ error: `unknown mode "${mode}"; use one|batch|missing` }, 400)
  }

  // Concurrency-bounded execution (max 4 concurrent Anthropic calls)
  const results: any[] = []
  const queue = [...ad_ids]
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const ad_id = queue.shift()!
      try {
        const classified = await classifyAd(supabase, ad_id, vocab)
        await persist(supabase, ad_id, classified)
        results.push({ ad_id, ok: true, attributes: classified.attributes })
      } catch (e: any) {
        results.push({ ad_id, ok: false, error: e.message })
      }
    }
  })
  await Promise.all(workers)

  return json({ ok: true, processed: results.length, results })
 } catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error('creative-tag-ad unhandled:', msg)
  return json({ error: `tag function crashed: ${msg.slice(0, 300)}` }, 500)
 }
})
