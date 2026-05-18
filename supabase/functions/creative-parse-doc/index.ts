// creative-parse-doc — Supabase Edge Function
//
// Takes a free-form document (operator pastes a Google Doc, Word file,
// markdown, etc — extracted to plain text on the client) and asks
// Claude to extract every distinct ad script. For each script, returns:
//   - title  (short, 4-6 words)
//   - body   (the full script text, lightly normalized)
//   - target_attributes (best-guess hook_type / message_frame / etc
//                        from the closed vocab)
//
// The output shape matches generated_scripts so the client can attach
// the parsed scripts to a test batch in one insert.
//
// Inputs (POST JSON):
//   {
//     text: string,           // required — plain text of the doc
//     offer_slug?: string,    // optional — pulls offer context for tagging
//   }
//
// Response:
//   { ok: true, scripts: [{ title, body, target_attributes, reasoning }] }
//
// ANTHROPIC_API_KEY required as Supabase secret.

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
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-4-20250514'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

async function loadVocab(supabase: any): Promise<Record<string, string[]>> {
  const { data, error } = await supabase
    .from('creative_attribute_vocab')
    .select('attribute_name, attribute_value')
    .eq('retired', false)
  if (error) throw new Error(`vocab fetch: ${error.message}`)
  const grouped: Record<string, string[]> = {}
  for (const row of data || []) {
    if (!grouped[row.attribute_name]) grouped[row.attribute_name] = []
    grouped[row.attribute_name].push(row.attribute_value)
  }
  return grouped
}

function buildToolSchema(vocab: Record<string, string[]>) {
  return {
    name: 'extract_scripts',
    description: 'Extract every distinct ad script from the document. Return one entry per script.',
    input_schema: {
      type: 'object',
      properties: {
        scripts: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: '3-6 word descriptive title for this script (used in the UI)',
              },
              body: {
                type: 'string',
                description: 'The full script text, lightly normalized (collapse repeated whitespace; preserve paragraphs and intentional line breaks). Do NOT summarize, paraphrase, or expand — only what the operator wrote.',
              },
              target_attributes: {
                type: 'object',
                description: 'Best-guess tags for this script. Use null for any field you cannot determine with confidence.',
                properties: {
                  hook_type:        { type: ['string', 'null'], enum: [...(vocab.hook_type || []), null] },
                  message_frame:    { type: ['string', 'null'], enum: [...(vocab.message_frame || []), null] },
                  mechanism_reveal: { type: ['string', 'null'], enum: [...(vocab.mechanism_reveal || []), null] },
                  pain_angle:       { type: ['string', 'null'], enum: [...(vocab.pain_angle || []), null] },
                  funnel_stage:     { type: ['string', 'null'], enum: [...(vocab.funnel_stage || []), null] },
                  awareness_level:  { type: ['string', 'null'], enum: [...(vocab.awareness_level || []), null] },
                  length_bucket:    { type: ['string', 'null'], enum: [...(vocab.length_bucket || []), null] },
                  format:           { type: ['string', 'null'], enum: [...(vocab.format || []), null] },
                  proof_character:  { type: ['string', 'null'], enum: [...(vocab.proof_character || []), null] },
                },
                required: ['hook_type', 'message_frame', 'mechanism_reveal', 'pain_angle', 'funnel_stage', 'awareness_level', 'length_bucket', 'format', 'proof_character'],
              },
              reasoning: {
                type: 'string',
                description: 'One short sentence on why these tags. Goes into notes.',
              },
            },
            required: ['title', 'body', 'target_attributes', 'reasoning'],
          },
        },
      },
      required: ['scripts'],
    },
  }
}

const SYSTEM = `You are extracting individual ad scripts from a document the operator wrote or pasted in.

INPUT FORMAT — varies. Could be:
- A numbered list ("Script 1: ...", "1.", "## Script", etc.)
- Scripts separated by --- / *** / blank lines
- A Google Doc dump with mixed formatting
- Just a wall of text with multiple clearly-distinct scripts

YOUR JOB:
1. Identify how many distinct scripts are in the document. If only one, return one.
2. For each script:
   - Title — short, what it's about ("Eric direct-call breakthrough", "Diagnostic TPA hook")
   - Body — the full script text, exactly as written. Strip Script N: prefixes but keep the actual content verbatim. Preserve paragraph breaks.
   - Tags — best-guess attributes from the closed vocab. Use null when you genuinely cannot tell.

DO NOT:
- Invent scripts that aren't there
- Summarize or paraphrase the body — preserve the operator's text
- Merge scripts that are clearly distinct
- Split a single script into multiple

Return through the extract_scripts tool.`

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: getCorsHeaders(req) })
  if (!ANTHROPIC_KEY) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } })

  let body: any
  try { body = await req.json() }
  catch { return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }) }

  const text: string = body.text || ''
  const offer_slug: string | null = body.offer_slug || null
  if (!text.trim()) return new Response(JSON.stringify({ error: 'text required' }), { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } })
  if (text.length > 200_000) return new Response(JSON.stringify({ error: 'text exceeds 200k characters' }), { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } })

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY)
  const vocab = await loadVocab(supabase)
  const tool = buildToolSchema(vocab)

  const userContent = [
    offer_slug ? `OFFER: ${offer_slug}` : null,
    'DOCUMENT TO PARSE:',
    '',
    text,
    '',
    'Extract every distinct script via the extract_scripts tool.',
  ].filter(Boolean).join('\n')

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: 'user', content: userContent }],
      tools: [tool],
      tool_choice: { type: 'tool', name: 'extract_scripts' },
    }),
  })

  if (!upstream.ok) {
    const errBody = await upstream.text()
    return new Response(JSON.stringify({ error: `Anthropic ${upstream.status}: ${errBody.slice(0, 500)}` }),
      { status: 502, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } })
  }
  const data = await upstream.json()
  const toolUse = data.content?.find((c: any) => c.type === 'tool_use')
  if (!toolUse?.input?.scripts) {
    return new Response(JSON.stringify({ error: 'no tool_use in response', raw: data }),
      { status: 502, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({
    ok: true,
    scripts: toolUse.input.scripts,
    model: ANTHROPIC_MODEL,
    usage: data.usage || null,
  }), { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } })
})
