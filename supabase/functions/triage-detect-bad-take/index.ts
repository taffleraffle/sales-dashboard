// triage-detect-bad-take — Supabase Edge Function
//
// Layer 3 of the failed-take detection system. After transcribe-library-clip
// lands a transcript on a row, this function asks Claude Haiku 4.5 whether
// the clip is a scratch take / restart / unusable take vs. a real usable
// take. If it's bad, sets is_bad_take=true + bad_take_source='ai' +
// bad_take_reason='<short reason>'. If it's good, leaves the row alone.
//
// CONSERVATIVE BY DESIGN: this should produce far more false negatives than
// false positives. A coordinator un-flagging a real take is cheap; an AI
// flagging a real take that doesn't reach the editor is expensive (the
// take is invisible to the matrix because hideBadTakes filter defaults on).
// Prompt biases toward "good unless clearly scratch."
//
// Skips rows that are already flagged (by Layer 1 upload toggle, Layer 2
// heuristic, or the coordinator) — never overwrites human / heuristic
// judgment.
//
// Body: { library_ids: string[] }  (UUIDs)
// Returns: { ok, evaluated, flagged, skipped, errors, rows: [...] }

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

async function classifyOne(row: any): Promise<{ bad: boolean, reason: string } | null> {
  const transcript = (row.transcript || '').trim()
  const visualDesc = (row.visual_description || '').trim()

  // No transcript AND no visual description -> nothing to judge from.
  // Return null so the caller marks this row as skipped (not bad).
  if (!transcript && !visualDesc) return null

  const sourceBlock = transcript
    ? `TRANSCRIPT (Whisper, may have minor errors):\n"""\n${transcript.length > 3000 ? transcript.slice(0, 3000) + '…' : transcript}\n"""${visualDesc ? `\n\nVISUAL:\n"""\n${visualDesc}\n"""` : ''}`
    : `VISUAL DESCRIPTION:\n"""\n${visualDesc}\n"""`

  const prompt = `You are reviewing a short-form ad clip for a paid-media library. The
operator records many takes; some are USABLE (real attempt at the script)
and some are FAILED takes (scratch, restart, false start, audio fail,
misread, mid-sentence cutoff, the operator talking about the clip rather
than delivering it).

${sourceBlock}

Classify the clip as either USABLE or BAD.

A take is BAD if any of these are clearly true:
- The speaker explicitly restarts ("let me try that again", "scrap that",
  "sorry, again", "take two", "one more time").
- The transcript is < 8 words AND the clip is clearly a video clip
  (suggests aborted recording).
- The speaker stops mid-sentence with no resolution.
- It's the operator setting up / off-camera chatter, not delivering a script.
- It's clearly a slate / verbal label only ("hook three, take five").

A take is USABLE if:
- The script is delivered coherently end to end, even if imperfect.
- The transcript contains a complete thought / pitch / hook.
- It's a static image with a meaningful visual_description.

WHEN IN DOUBT, mark USABLE. False positives are costly because the clip
gets hidden from the editor.

Return JSON with exactly two fields:
  classification  - "USABLE" or "BAD"
  reason          - one short phrase (max 60 chars) explaining the
                    classification. For USABLE, something like "coherent
                    pitch delivered"; for BAD, the specific tell ("speaker
                    restarted", "transcript < 8 words", "off-camera setup").

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
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error(`no JSON in response: ${text.slice(0, 200)}`)
  const parsed = JSON.parse(m[0])
  const cls = String(parsed.classification || '').toUpperCase()
  return {
    bad: cls === 'BAD',
    reason: String(parsed.reason || '').slice(0, 80),
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

  // Pull only the columns we need. is_bad_take + bad_take_source are
  // consulted so we don't re-evaluate rows that were already flagged by
  // Layer 1 / Layer 2 / coordinator (we'd be wasting Claude tokens and
  // also could regress a human judgment to AI's).
  const { data: rows, error: selErr } = await supabase
    .from('lib_creative_library')
    .select('id, transcript, visual_description, preview_url, is_bad_take, bad_take_source')
    .in('id', ids)
  if (selErr) return json({ error: `select: ${selErr.message}` }, 500)

  const results: any[] = []
  const errors: any[] = []
  let evaluated = 0
  let flagged = 0
  let skipped = 0

  for (const row of rows || []) {
    // Never overwrite a non-AI flag.
    if (row.is_bad_take === true && row.bad_take_source !== 'ai') {
      results.push({ id: row.id, skipped: 'already flagged by ' + (row.bad_take_source || 'unknown') })
      skipped++
      continue
    }
    try {
      const out = await classifyOne(row)
      if (!out) {
        results.push({ id: row.id, skipped: 'no transcript or visual description' })
        skipped++
        continue
      }
      evaluated++
      if (out.bad) {
        const { error: upErr } = await supabase.from('lib_creative_library').update({
          is_bad_take: true,
          bad_take_reason: `ai: ${out.reason}`,
          bad_take_source: 'ai',
        }).eq('id', row.id)
        if (upErr) {
          errors.push({ id: row.id, error: upErr.message })
          continue
        }
        flagged++
        results.push({ id: row.id, bad: true, reason: out.reason })
      } else {
        // USABLE — leave row state alone, but record the decision for audit.
        results.push({ id: row.id, bad: false, reason: out.reason })
      }
    } catch (e: any) {
      errors.push({ id: row.id, error: e?.message || String(e) })
    }
  }

  return json({
    ok: true,
    requested: ids.length,
    evaluated,
    flagged,
    skipped,
    errors,
    rows: results,
  })
})
