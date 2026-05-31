// creative-generate-script — Supabase Edge Function
//
// Generic ad-script generator. Takes an offer slug + optional target attributes
// + N concepts, returns Claude-generated scripts that apply all the locked
// principles from ad-creative-kb (Truth-vs-Trust, Schwartz, hook qualification
// gate, no structural tics, etc).
//
// Inputs (POST JSON):
//   {
//     offer_slug: string,                     // FK to offers.slug
//     n_concepts: number,                     // 1-30
//     target_attributes?: {                   // all optional — used to bias generation
//       hook_type?: string | string[],        // single value = constrain; array = distribute across
//       message_frame?: string | string[],
//       mechanism_reveal?: string | string[],
//       pain_angle?: string | string[],
//       funnel_stage?: string | string[],
//       awareness_level?: string | string[],
//       length_bucket?: string | string[],
//     },
//     save_as_drafts?: boolean,              // if true, insert into generated_scripts
//   }
//
// Response:
//   { ok: true, scripts: [...], saved_variant_ids?: [...] }
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

// ── Locked principles (from ad-creative-kb/written-docs/) ─────────────
// Embedded as constants rather than read from disk because Edge Functions
// run in Deno isolates without filesystem access to the rest of the repo.
// When KB principles change, update here AND in ad-creative-kb/prompts/.
const LOCKED_PRINCIPLES = `LOCKED PRINCIPLES (from ad-creative-kb/written-docs/, applied to every script):

1. TRUTH-VS-TRUST (Sultanic) — Sophisticated markets demand mechanism-led copy with indisputable evidence. Lead with the named mechanism + verifiable proof. Adjectives are banned (no "amazing", "incredible", "game-changing"). Every claim names a specific number, named client, or specific deliverable.

2. SCHWARTZ AWARENESS DISCIPLINE (multi-axis) — Awareness is multi-axis (problem / solution-category / mechanism / brand). The brand-named mechanism is INTRODUCED in body, NEVER assumed in the hook. Hooks lead with the LOWEST axis the prospect knows. For Most-Aware audiences, mechanism comparison (Stage 4) is allowed; for Solution-Aware and below, stay at mechanism-led (Stage 3).

3. HOOK QUALIFICATION GATE — Every hook must include a vertical-specific anchor in line 1 or line 2. Rotate the anchor vocabulary (water mit, mit crew, mit shop, water-damage, mold, smoke response, TPA, insurance adjuster, basement flood, restoration phone, etc) so the anchor itself doesn't become a structural tic. Universal hooks ("If your phone hasn't rung this week...") are banned.

4. BANNED STRUCTURAL TICS — Never use:
   - "Two paths / Option one / Option two" framing (binary path metaphor)
   - "X isn't Y, it's Z" reframes
   - "Most owners never..." aphorisms
   - "Here's the trap..." textbook openers
   - "Watch this" verbal tic
   - Triadic exclusion lists ("No plumbers. No HVAC. No roofers.") more than once per deck

5. ONE-NAMED-CHARACTER-PER-SCRIPT — Each script uses ONE focal proof character with a specific story. Listing multiple names (Eric AND Adam AND Belinda) in one script is banned — one strong proof beats three name-drops.

6. MESSAGE FRAME DISCIPLINE — Each script targets exactly one Message Frame: Problem (active pain), Circumstance (specific situation prospect is in), or Outcome (vivid end-state, scene-painted). The frame is the testing variable.

7. MECHANISM REVEAL — GATED scripts use the brand-name (e.g. "The Direct Call Engine") with brief context; EXPLICIT scripts name the literal deliverable (e.g. "top 3 in Google Maps") with dual-guarantee. Pick one mode per script.

8. LENGTH DISCIPLINE — Target length bucket determines the structural shape: under_60s scripts use piercing hook + tight body + CTA; 60-75s scripts add one proof beat; 75s+ scripts paint a full scene.

9. CTA STRUCTURE — End with one clear conditional CTA + the guarantee. For dual-guarantee offers: "[Outcome 1] in 90 days. [Outcome 2] in 90 days. Money back if neither happens. Tap below." For single-guarantee: "Crews booked from direct homeowner calls in 90 days. Money back if not. Tap below."`

// ── System prompt ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a senior direct-response copywriter for OPT Digital. You write Meta-ad scripts (60-90s talking-head / UGC) that apply Eugene Schwartz Breakthrough Advertising + Truth-vs-Trust + the OPT structural-discipline rules locked from 21 versions of iteration.

${LOCKED_PRINCIPLES}

You will be given:
- The offer this script is for (offer slug, mechanism name, primary audience, proof characters)
- Optional target attributes that bias the generation (e.g. "hook_type=conditional", "message_frame=problem")
- Winning attribute patterns observed for this offer in the last 60 days (if any data exists)
- A request for N script concepts

Return scripts via the generate_scripts tool. Each script:
- ref: a short reference ID (e.g. "M1", "M2" — sequential)
- title: 4-7 word title
- frame: PROBLEM | CIRCUMSTANCE | OUTCOME
- length_bucket: under_60s | sixty_75s | over_75s
- hook_type: question | scene | dollar_pain | diagnostic | conditional
- mechanism_reveal: gated | explicit | hidden
- pain_angle: from vocab
- proof_character: from offer's default_proof_characters, or none
- awareness_level: Schwartz 5 stages
- funnel_stage: tof | mof | bof | cross
- body: the full script text (target the length_bucket — ~150 wpm)
- target_attributes_met: object showing which target attributes are present in this script

Be ruthlessly literal. No adjective-heavy filler. No marketing-speak. Use editorial em-dashes — like this — not double-dashes.`

// ── Template-based generator (Ben 2026-05-31) ─────────────────────────
//
// New code path that consumes the script_angles / script_proof_characters /
// script_hook_shapes / script_body_skeletons tables introduced in migration
// 105. The legacy offer-based path below is preserved for callers that
// don't yet send angle_slug + script_type. Branch is selected at the top
// of serve().

async function loadAngle(supabase: any, slug: string) {
  const { data, error } = await supabase.from('script_angles').select('*').eq('slug', slug).maybeSingle()
  if (error) throw new Error(`angle fetch: ${error.message}`)
  if (!data) throw new Error(`angle "${slug}" not found`)
  return data
}

async function loadMechanism(supabase: any, slug: string) {
  if (!slug) return null
  const { data, error } = await supabase.from('script_mechanisms').select('*').eq('slug', slug).maybeSingle()
  if (error) throw new Error(`mechanism fetch: ${error.message}`)
  if (!data) throw new Error(`mechanism "${slug}" not found`)
  return data
}

async function loadProofCharacters(supabase: any, angle_slug: string) {
  const { data, error } = await supabase
    .from('script_proof_characters')
    .select('name, result_short, result_long, industry_context, metric_kind, display_order')
    .eq('angle_slug', angle_slug)
    .eq('active', true)
    .order('display_order')
  if (error) throw new Error(`proof_characters fetch: ${error.message}`)
  return data || []
}

async function loadHookShapes(supabase: any, target_codes?: string[]) {
  let q = supabase
    .from('script_hook_shapes')
    .select('code, name, description, structural_template, example_filled, message_frame, display_order')
    .eq('active', true)
    .order('display_order')
  if (target_codes && target_codes.length) q = q.in('code', target_codes)
  const { data, error } = await q
  if (error) throw new Error(`hook_shapes fetch: ${error.message}`)
  return data || []
}

async function loadBodySkeletons(supabase: any, length_bucket?: string) {
  let q = supabase
    .from('script_body_skeletons')
    .select('code, name, description, beat_structure, example_filled, length_bucket, display_order')
    .eq('active', true)
    .order('display_order')
  if (length_bucket) q = q.eq('length_bucket', length_bucket)
  const { data, error } = await q
  if (error) throw new Error(`body_skeletons fetch: ${error.message}`)
  return data || []
}

// Build the angle-context block that prefixes every template-based prompt.
// When mechanism is provided (migration 108), its short/long/3-part-HOW
// take precedence over the angle's legacy mechanism fields. This lets the
// same angle (problem/desire door) be paired with different mechanisms
// across campaigns without editing the angle row.
function buildAngleContext(angle: any, proofs: any[], mechanism: any = null): string {
  const proofRoster = proofs.length
    ? proofs.map((p, i) => `${i + 1}. ${p.name} — ${p.result_short}  (long: "${p.name} ${p.result_long}")`).join('\n')
    : '(no proof characters defined for this angle — generate WITHOUT naming any specific clients; use generic phrasing like "our clients" only if absolutely required, and prefer omitting proof entirely so the operator can drop a real win in later)'
  const pains = angle.pain_points || []
  const painBlock = pains.length
    ? `\nPAIN POINTS (use these as the lived-reality of the prospect — Shape C "Pain anchor" hooks especially must lean on specific items from this list, NOT generic competitor language. Other shapes can reference one or two of these as supporting context):\n${pains.map((p: string) => `  - ${p}`).join('\n')}`
    : ''
  // Mechanism precedence: explicit mechanism > angle's legacy fields.
  const mech_short = mechanism?.mechanism_short || angle.mechanism_short
  const mech_long  = mechanism?.mechanism_long  || angle.mechanism_long
  const mechBlock = mechanism
    ? `\nMECHANISM PICKED: ${mechanism.name}${mechanism.summary ? ' — ' + mechanism.summary : ''}`
    : ''
  // 3-part HOW for body Beat 5 — comes from mechanism table when available.
  const howBlock = (mechanism?.beat_5a || mechanism?.beat_5b || mechanism?.beat_5c)
    ? `\n3-PART HOW (use these as Beat 5a / 5b / 5c in the body skeleton — one sentence each, in order):\n  5a: ${mechanism.beat_5a || '(unset)'}\n  5b: ${mechanism.beat_5b || '(unset)'}\n  5c: ${mechanism.beat_5c || '(unset)'}`
    : ''
  return [
    `ANGLE: ${angle.name}`,
    `QUALIFIER (the audience-filter opening line shape): ${angle.qualifier}`,
    `PRIMARY PROMISE (every script must deliver on exactly this): ${angle.primary_promise}`,
    `MECHANISM (short, for hook use): ${mech_short}`,
    mech_long ? `MECHANISM (long, for body reveal beat 4): ${mech_long}` : '',
    mechBlock,
    howBlock,
    `GUARANTEE CLOSE: ${angle.guarantee_close}`,
    angle.cta_teeup ? `CTA TEE-UP (body beat 1 opener template): ${angle.cta_teeup}` : '',
    angle.anchor_vocab?.length ? `ANCHOR VOCAB (rotate so anchors don't become a structural tic): ${angle.anchor_vocab.join(' · ')}` : '',
    painBlock,
    '',
    `PROOF CHARACTERS (you may name only these, in only these forms — if there's only one, use them as the single focal proof and lean into BOTH their result_short and result_long color rather than padding with fabricated others. If there are ZERO, omit proof beats entirely or use [CLIENT NAME — fill] placeholder markers):`,
    proofRoster,
  ].filter(Boolean).join('\n')
}

function buildHookShapesBlock(shapes: any[]): string {
  return shapes.map(s => [
    `Shape ${s.code} — ${s.name}`,
    `Description: ${s.description}`,
    s.message_frame ? `Natural message frame: ${s.message_frame}` : '',
    `Structural template (slot markers get filled from the angle + proof_characters):`,
    `  ${s.structural_template}`,
    s.example_filled ? `Worked example (becoming-1-in-city):\n  ${s.example_filled}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')
}

function buildBodySkeletonsBlock(skeletons: any[]): string {
  return skeletons.map(s => [
    `Body skeleton ${s.code} — ${s.name} (length bucket: ${s.length_bucket})`,
    `Description: ${s.description}`,
    `Beat structure:`,
    ...(s.beat_structure || []).map((b: string) => `  ${b}`),
    s.example_filled ? `Worked example:\n${s.example_filled.split('\n').map((l: string) => '  ' + l).join('\n')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')
}

// Each shape gets equal share of the N concepts. Rotation ensures the
// generator doesn't over-index on one shape (the previous attribute-based
// path produced 7/10 hooks all in "conditional" shape on the first run).
function planShapeRotation(shapes: any[], n: number): string[] {
  if (!shapes.length) return []
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(shapes[i % shapes.length].code)
  return out
}

const TEMPLATE_TOOL_NAMES: Record<string, string> = {
  hook:   'generate_hooks',
  body:   'generate_bodies',
  joined: 'generate_joined_scripts',
}

function buildTemplateToolSchema(script_type: string, n: number, shape_codes: string[]) {
  const itemBase: any = {
    type: 'object',
    properties: {
      ref:    { type: 'string', description: 'short sequential reference like H1, H2, ...' },
      body:   { type: 'string', description: 'the script text. Plain text, paragraph breaks for sentence groups, NO markdown' },
      proof_character: { type: 'string', description: 'which proof character name is used in this script, exactly as listed in the angle context' },
      notes:  { type: 'string', description: 'one-line note on why this concept' },
    },
    required: ['ref', 'body'],
  }
  if (script_type === 'hook' || script_type === 'joined') {
    itemBase.properties.shape_code = {
      type: 'string',
      enum: shape_codes,
      description: 'the hook shape code this script uses (must match the rotation plan)',
    }
    itemBase.required.push('shape_code')
  }
  if (script_type === 'joined') {
    itemBase.properties.hook_text = {
      type: 'string',
      description: 'the standalone hook portion of the joined script (so we can also save it as a Hook variant)',
    }
    itemBase.properties.body_text = {
      type: 'string',
      description: 'the body portion that continues from hook_text',
    }
    itemBase.required.push('hook_text', 'body_text')
  }
  return {
    name: TEMPLATE_TOOL_NAMES[script_type],
    description: `Return exactly ${n} ${script_type} concepts.`,
    input_schema: {
      type: 'object',
      properties: {
        scripts: { type: 'array', items: itemBase, minItems: n, maxItems: n },
      },
      required: ['scripts'],
    },
  }
}

// ── Messaging (angles) generator — Ben 2026-05-31 ────────────────────
//
// New "Messaging" mode that produces script_angles rows from an offer
// directly. The output is N problem angles + M desire angles, each in
// the prospect's first-person voice, with a Claude-written one-line
// hook_build_sketch describing which shape fits + the opening posture.
// Auto-saved to the angle library so they appear in the Scripts >
// Angle picker on the very next page render.

const ANGLE_SYSTEM_PROMPT = `You are OPT Digital's senior direct-response strategist. You write ANGLES — not headlines, not hooks, not bodies — ANGLES.

An angle is the EMOTIONAL DOOR a prospect walks through. It is a problem they are stuck on OR a desire they are chasing, phrased in the prospect's own first-person voice. Mechanism (what the company sells) attaches LATER. Proof characters attach LATER. The angle is upstream of both.

Rules:
- Each angle is ONE problem or ONE desire. Not a solution.
- Phrased in the prospect's voice — "I can't hire a senior accountant" not "Senior accountant hiring is hard."
- Specific to the lived reality of the prospect at the audience qualifier (e.g. CPA firms at $50k/month have specific pains that $5k/month bookkeepers don't share).
- Visceral and concrete. Names specific things: software names, dollar amounts, scenarios.
- Banned: generic agency-speak ("grow your business", "scale your firm", "stand out from competitors"). Specific over abstract.
- Banned: solutions in the angle. The angle is the door; the solution comes after.

For each angle, also produce a hook_build_sketch — ONE LINE describing how the angle becomes a hook. Format: "Shape {X} ({shape name}). Opens '{first 12-20 words of the hook leading with the angle's voice}...'"

Hook shapes available:
  A. Direct offer — open with qualifier + flat offer + guarantee
  B. Hypothetical question — "If we told you we could ___, would you take us up on it?"
  C. Pain anchor — open with conditional pain ("If you... and you're tired of ___...")
  D. Reality statement — flat truth about the prospect's current state
  E. Curiosity question — "How is it possible some ___ while others ___?"
  F. Reframe — "The X isn't Y, it's Z"
  G. Desire question — "Want to be the ___?"
  H. Trend/future — "The ___ that survive 2027 won't be ___"

Pick the shape that the angle's voice MOST NATURALLY implies.`

const ANGLE_TOOL_NAME = 'generate_angles'

function buildAngleToolSchema(n_problems: number, n_desires: number, groundingCount: number) {
  const angleItem = {
    type: 'object',
    properties: {
      angle_type: { type: 'string', enum: ['problem', 'desire'] },
      name: {
        type: 'string',
        description: 'A short title (3-7 words) summarizing the angle. Will be displayed in the picker.',
      },
      prospect_voice: {
        type: 'string',
        description: "The angle phrased in the prospect's own first-person voice, 1 sentence. E.g. \"I can't hire a senior accountant for love or money.\" or \"I want to be the CPA every banker in my city refers to.\"",
      },
      pain_points: {
        type: 'array',
        items: { type: 'string' },
        description: '2-4 specific lived-reality details that make this angle visceral. E.g. for the bookkeeping pain: ["watching Bench cold-pitch $300/mo clients", "QBO Live offering software-plus-human at half my price", "every renewal becoming a price negotiation"]. Used as PAIN POINTS block in script generation.',
      },
      hook_build_sketch: {
        type: 'string',
        description: 'ONE LINE: which shape fits + first 12-20 words of how the hook would open. Format: "Shape C (Pain anchor). Opens \\"If you run a CPA firm doing $50k a month and you\'re watching Bench cold-pitch your bookkeeping clients...\\""',
      },
      why_it_matters: {
        type: 'string',
        description: 'PROSE PARAGRAPH (4-6 sentences) on WHY this problem/desire bites for this audience. Cover: the consequences of NOT solving it (what falls apart), the deeper anxiety underneath (identity, status, peer comparison), what they have already tried that failed, and the specific moment of friction. Visceral, not abstract.',
      },
      evidence_examples: {
        type: 'array',
        items: { type: 'string' },
        description: '2-3 CONCRETE SITUATIONAL MOMENTS where this angle bites. Specific scenes, not summaries. E.g. "Refreshing the CRM at 9pm hoping a call came in.", "Asking his wife why he\'s stressed and not wanting to explain HomeAdvisor again.", "Walking past the new hire\'s empty desk because there\'s no work to give them."',
      },
      sources: groundingCount > 0
        ? {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer', description: '1-based index into the GROUNDING SOURCES block in the user message. Cite the index of every source you used to inform this angle.' },
                relevance: { type: 'string', description: 'One sentence on what this source contributed to the angle (a phrase, a specific concern, a competitor name, etc).' },
              },
              required: ['index', 'relevance'],
            },
            description: `Cite the GROUNDING SOURCES (1-${groundingCount}) you actually used while writing this angle. Cite ONLY sources that informed THIS specific angle — do not include every source on every angle. If you wrote this angle purely from training-data reasoning without consulting the grounding block, return an empty array. Do NOT invent sources.`,
          }
        : {
            type: 'array',
            items: { type: 'object', properties: {}, additionalProperties: false },
            description: 'No grounding sources were provided for this generation. Return an empty array. Never fabricate sources.',
            maxItems: 0,
          },
    },
    required: ['angle_type', 'name', 'prospect_voice', 'hook_build_sketch', 'why_it_matters', 'evidence_examples', 'sources'],
  }
  return {
    name: ANGLE_TOOL_NAME,
    description: `Return exactly ${n_problems} problem angles + ${n_desires} desire angles for this offer's prospect. Problems first, then desires.`,
    input_schema: {
      type: 'object',
      properties: {
        angles: {
          type: 'array',
          items: angleItem,
          minItems: n_problems + n_desires,
          maxItems: n_problems + n_desires,
        },
      },
      required: ['angles'],
    },
  }
}

// ── Serper grounding ─────────────────────────────────────────────────
// Pulls real top organic search results and feeds title+snippet+url to
// Claude as grounding context. Degrades cleanly when SERPER_API_KEY is
// unset — generation still runs, just without sources.
//
// Anti-hallucination contract (Ben 2026-05-31): if grounding is present,
// Claude MAY cite indices into the grounding block. If grounding is
// absent, the angle tool schema forbids any sources entries. Either way
// Claude is told "do not invent sources".
type GroundingHit = { title: string; url: string; snippet: string }

async function fetchGrounding(query: string, n = 6): Promise<GroundingHit[]> {
  const key = Deno.env.get('SERPER_API_KEY')
  if (!key) return []
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: Math.min(20, Math.max(1, n)) }),
    })
    if (!res.ok) {
      console.warn(`[grounding] serper ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return []
    }
    const data = await res.json()
    const organic = Array.isArray(data?.organic) ? data.organic : []
    return organic.slice(0, n).map((r: any) => ({
      title: (r.title || '').toString().slice(0, 200),
      url: (r.link || '').toString().slice(0, 500),
      snippet: (r.snippet || '').toString().slice(0, 400),
    })).filter((h: GroundingHit) => h.title && h.url)
  } catch (e: any) {
    console.warn(`[grounding] serper threw: ${e.message}`)
    return []
  }
}

function formatGroundingBlock(hits: GroundingHit[]): string {
  if (!hits.length) return ''
  const lines = hits.map((h, i) => `[${i + 1}] ${h.title}\n     ${h.url}\n     ${h.snippet}`)
  return `\nGROUNDING SOURCES (use these to keep angles concrete and citable; reference by index in your sources field):\n\n${lines.join('\n\n')}\n\nIMPORTANT: only cite sources you actually drew from. Do NOT invent URLs. If you wrote an angle from training-data reasoning without using these sources, leave its sources array empty.\n`
}

// ── Legacy helpers (existing offer-based generator) ───────────────────
async function loadOffer(supabase: any, slug: string) {
  const { data, error } = await supabase.from('offers').select('*').eq('slug', slug).maybeSingle()
  if (error) throw new Error(`offer fetch: ${error.message}`)
  if (!data) throw new Error(`offer "${slug}" not found`)
  return data
}

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

async function loadWinnerPatterns(supabase: any, offer_slug: string) {
  // Last 60 days, top winning attribute combos for this offer
  const since = new Date(Date.now() - 60 * 86400 * 1000).toISOString().slice(0, 10)
  const until = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase.rpc('lib_winning_attributes', { since, until })
  if (error) return [] // soft-fail — generator still works without winner context
  // Filter to attributes that likely apply (this is a soft filter — we want
  // global signal too, since OPT may have few winners per offer early)
  return (data || []).slice(0, 10)
}

function buildToolSchema(vocab: Record<string, string[]>, n_concepts: number, offerProofChars: string[] = []) {
  // proof_character enum: union of global vocab + offer's default_proof_characters
  // (real client names like "Eric", "Adam" may not be in the global vocab table)
  const proofEnum = Array.from(new Set([
    ...(vocab.proof_character || []),
    ...offerProofChars.map(c => c.toLowerCase()),
    ...offerProofChars,  // also include original casing in case operator uses 'Eric' not 'eric'
  ]))

  const scriptItem = {
    type: 'object',
    properties: {
      ref:              { type: 'string' },
      title:            { type: 'string' },
      frame:            { type: 'string', enum: ['PROBLEM', 'CIRCUMSTANCE', 'OUTCOME'] },
      length_bucket:    { type: 'string', enum: vocab.length_bucket || [] },
      hook_type:        { type: 'string', enum: vocab.hook_type || [] },
      mechanism_reveal: { type: 'string', enum: vocab.mechanism_reveal || [] },
      pain_angle:       { type: 'string', enum: vocab.pain_angle || [] },
      proof_character:  { type: 'string', enum: proofEnum },
      awareness_level:  { type: 'string', enum: vocab.awareness_level || [] },
      funnel_stage:     { type: 'string', enum: vocab.funnel_stage || [] },
      body:             { type: 'string', description: 'Full script text. Use paragraph breaks for sentence groups. No markdown.' },
      target_attributes_met: {
        type: 'object',
        description: 'Map of requested target_attributes → whether this script honors them',
        additionalProperties: { type: 'boolean' },
      },
    },
    required: ['ref','title','frame','length_bucket','hook_type','mechanism_reveal','pain_angle','proof_character','awareness_level','funnel_stage','body'],
  }
  return {
    name: 'generate_scripts',
    description: `Return an array of exactly ${n_concepts} script concepts.`,
    input_schema: {
      type: 'object',
      properties: {
        scripts: { type: 'array', items: scriptItem, minItems: n_concepts, maxItems: n_concepts },
      },
      required: ['scripts'],
    },
  }
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

  const offer_slug = body?.offer_slug
  const angle_slug = body?.angle_slug
  const mechanism_slug = body?.mechanism_slug    // migration 108 — optional
  const generation_target = body?.generation_target  // 'angles' | undefined
  const script_type = body?.script_type   // 'hook' | 'body' | 'joined'
  const target_shapes_raw = body?.target_shapes
  const target_length    = body?.target_length      // 'under_60s' | '60_75s' | '75s_plus'
  const n_concepts = Math.max(1, Math.min(30, body?.n_concepts || 5))
  const target_attributes_raw = body?.target_attributes || {}
  const save_as_drafts = !!body?.save_as_drafts
  // Optional subset of proof character names to feature this batch.
  // Empty/undefined = use all active proofs for the angle (default).
  const target_proof_characters: string[] = Array.isArray(body?.target_proof_characters)
    ? body.target_proof_characters.filter((n: any) => typeof n === 'string' && n.trim()).map((n: string) => n.trim())
    : []
  // Free-text operator instructions appended to the Claude prompt for
  // this run only. Trimmed + length-capped to keep token usage sane
  // (anything longer than ~4k chars is likely a copy/paste mistake).
  const extra_instructions: string = typeof body?.extra_instructions === 'string'
    ? body.extra_instructions.trim().slice(0, 4000)
    : ''
  const extraBlock = extra_instructions
    ? `\n\nOPERATOR INSTRUCTIONS FOR THIS RUN (these take precedence over generic defaults; honor them literally):\n${extra_instructions}\n`
    : ''

  // ── BRANCH: Messaging mode (Ben 2026-05-31) — generate angles ──
  // Produces N problem + M desire angles for an offer and auto-saves to
  // script_angles so they appear in the Scripts > Angle picker immediately.
  if (generation_target === 'angles') {
    if (!offer_slug) return json({ error: 'offer_slug required for angle generation' }, 400)
    const n_problems = Math.max(0, Math.min(20, body?.n_problems ?? 5))
    const n_desires  = Math.max(0, Math.min(20, body?.n_desires ?? 5))
    if (n_problems + n_desires === 0) return json({ error: 'n_problems + n_desires must be > 0' }, 400)
    const niche_hint = (body?.niche_hint || '').trim()

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    let offer: any
    try { offer = await loadOffer(supabase, offer_slug) }
    catch (e: any) { return json({ error: e.message }, 500) }

    // Real grounding: pull top organic results so Claude has actual
    // forum/article snippets to anchor why_it_matters + evidence_examples
    // against. Empty array when SERPER_API_KEY is unset on the function
    // — generation still runs, just without sources.
    const groundingQuery = [
      offer.vertical || '',
      offer.primary_audience || '',
      niche_hint || '',
      'owner problems frustrations forum',
    ].filter(Boolean).join(' ').slice(0, 220)
    const grounding = await fetchGrounding(groundingQuery, 6)
    const groundingBlock = formatGroundingBlock(grounding)

    const userMsg = [
      `OFFER: ${offer.name} (slug: ${offer.slug})`,
      `VERTICAL: ${offer.vertical}`,
      `PRIMARY AUDIENCE: ${offer.primary_audience || '(none defined)'}`,
      offer.mechanism_name ? `BRAND-NAMED MECHANISM (only mention in passing; the angles are upstream of mechanism): ${offer.mechanism_name}` : '',
      niche_hint ? `\nADDITIONAL CONTEXT FROM OPERATOR: ${niche_hint}\nUse this to bias the angles toward the specific niche / situation the operator named.` : '',
      groundingBlock,
      '',
      `Generate exactly ${n_problems} PROBLEM angles and ${n_desires} DESIRE angles.`,
      'Problems = what the prospect is stuck on, phrased in their voice. Desires = what they want, phrased in their voice.',
      'Each angle must be specific to the audience qualifier (above). Generic "grow your business" angles will be rejected.',
      'For each angle, ALSO write why_it_matters (consequences + deeper anxiety + what they\'ve tried) and 2-3 evidence_examples (concrete situational moments, not summaries). These are not optional.',
      grounding.length
        ? 'Cite only the GROUNDING SOURCES you actually drew from for each angle. If an angle came from reasoning alone, leave its sources array empty. NEVER invent URLs or titles.'
        : 'No grounding sources were provided this run. Leave every sources array empty. NEVER invent sources.',
      `Return via the ${ANGLE_TOOL_NAME} tool with problems first, then desires.`,
      extraBlock,
    ].filter(Boolean).join('\n')

    const upstreamA = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 3500 + (n_problems + n_desires) * 400,
        system: ANGLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
        tools: [buildAngleToolSchema(n_problems, n_desires, grounding.length)],
        tool_choice: { type: 'tool', name: ANGLE_TOOL_NAME },
      }),
    })
    if (!upstreamA.ok) {
      const errText = await upstreamA.text()
      return json({ error: `Anthropic ${upstreamA.status}: ${errText.slice(0, 400)}` }, 502)
    }
    const resultA = await upstreamA.json()
    const toolUseA = (resultA.content || []).find((c: any) => c.type === 'tool_use')
    if (!toolUseA) return json({ error: 'Claude did not return angle tool_use', raw: resultA }, 502)
    const generated_angles: any[] = toolUseA.input?.angles || []

    // Resolve Claude's cited source indices back to {title, url, snippet}
    // objects. We trust only indices into the grounding array — Claude
    // can NOT fabricate URLs because the schema only accepts an index
    // (when grounding is present) or rejects sources entirely (when not).
    function resolveSources(rawSources: any): Array<{ title: string; url: string; snippet: string; relevance: string }> {
      if (!Array.isArray(rawSources) || !grounding.length) return []
      const out: Array<{ title: string; url: string; snippet: string; relevance: string }> = []
      const seen = new Set<string>()
      for (const s of rawSources) {
        const idx = typeof s?.index === 'number' ? s.index - 1 : -1
        const hit = idx >= 0 && idx < grounding.length ? grounding[idx] : null
        if (!hit || seen.has(hit.url)) continue
        seen.add(hit.url)
        out.push({
          title: hit.title,
          url: hit.url,
          snippet: hit.snippet,
          relevance: typeof s?.relevance === 'string' ? s.relevance.slice(0, 280) : '',
        })
      }
      return out
    }

    // Auto-save each angle to script_angles with a generated slug. We
    // tag them with the offer's slug so the Angle picker filters them
    // by offer cleanly. existing angles with the same slug get updated
    // (idempotent) so re-generating doesn't error.
    //
    // Slug is derived from offer + angle_type + name only (NO timestamp,
    // NO index). This is intentional — when the operator regenerates for
    // the same offer and Claude returns an angle with the same name, we
    // want the existing row to be updated in place rather than
    // accumulating dupes in the library (Ben 2026-05-31).
    const slugify = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
    // Dedupe within this batch first: if Claude ever returns two angles
    // with the same name in one call, we'd otherwise hit a unique-key
    // collision inside the upsert array. Keep the first occurrence.
    const seenSlugs = new Set<string>()
    const inserts: any[] = []
    // Resolve sources for each angle so the inserts (and the response
    // payload) carry the same shape. Mutate the generated_angles entry
    // too so the API response has the resolved URLs the UI can render
    // without re-doing the index lookup.
    for (const a of generated_angles) {
      const slug = `${offer.slug}-${a.angle_type}-${slugify(a.name)}`
      if (!slug || seenSlugs.has(slug)) continue
      seenSlugs.add(slug)
      const resolved = resolveSources(a.sources)
      a.sources = resolved   // mutate so caller sees URLs not indices
      inserts.push({
        slug,
        name: a.name,
        angle_type: a.angle_type,
        prospect_voice: a.prospect_voice,
        hook_build_sketch: a.hook_build_sketch,
        pain_points: Array.isArray(a.pain_points) ? a.pain_points : [],
        why_it_matters: typeof a.why_it_matters === 'string' ? a.why_it_matters : null,
        evidence_examples: Array.isArray(a.evidence_examples) ? a.evidence_examples : [],
        sources: resolved,
        offer_slugs: [offer.slug],
        qualifier: offer.primary_audience || '',
        primary_promise: '',       // filled by Claude or operator later when used in Scripts
        mechanism_short: '',       // mechanism comes from script_mechanisms (migration 108)
        guarantee_close: '',       // operator can set or use offer default
        active: true,
      })
    }

    let saved: any[] = []
    let save_error: string | undefined
    try {
      const { data, error } = await supabase
        .from('script_angles')
        .upsert(inserts, { onConflict: 'slug' })
        .select()
      if (error) save_error = error.message
      else saved = data || []
    } catch (e: any) {
      save_error = e.message
    }

    return json({
      ok: true,
      mode: 'messaging',
      target: 'angles',
      offer: { slug: offer.slug, name: offer.name, vertical: offer.vertical },
      angles: generated_angles,
      saved,
      save_error,
      model: ANTHROPIC_MODEL,
      grounding: {
        enabled: !!Deno.env.get('SERPER_API_KEY'),
        query: groundingQuery,
        hits: grounding.length,
      },
    })
  }

  // ── BRANCH: template-based generator (new Ben 2026-05-31 path) ──
  if (script_type && angle_slug) {
    if (!['hook', 'body', 'joined'].includes(script_type)) {
      return json({ error: `script_type must be one of hook | body | joined` }, 400)
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const target_shapes = Array.isArray(target_shapes_raw)
      ? target_shapes_raw.filter((s: any) => typeof s === 'string')
      : (typeof target_shapes_raw === 'string' && target_shapes_raw ? [target_shapes_raw] : [])

    let angle: any, mechanism: any = null, proofs: any[], shapes: any[], skeletons: any[]
    try {
      const needsShapes = script_type === 'hook' || script_type === 'joined'
      const needsSkeletons = script_type === 'body' || script_type === 'joined'
      ;[angle, mechanism, proofs, shapes, skeletons] = await Promise.all([
        loadAngle(supabase, angle_slug),
        mechanism_slug ? loadMechanism(supabase, mechanism_slug) : Promise.resolve(null),
        loadProofCharacters(supabase, angle_slug),
        needsShapes ? loadHookShapes(supabase, target_shapes.length ? target_shapes : undefined) : Promise.resolve([]),
        needsSkeletons ? loadBodySkeletons(supabase, target_length) : Promise.resolve([]),
      ])
    } catch (e: any) {
      return json({ error: e.message }, 500)
    }
    // Subset proof characters if the operator picked specific names. If
    // the subset is non-empty but doesn't match any loaded proofs, we
    // intentionally let the array stay empty (no proofs) so the generator
    // hits the "(none)" path rather than silently using the full set.
    if (target_proof_characters.length) {
      const allow = new Set(target_proof_characters.map(n => n.toLowerCase()))
      proofs = proofs.filter((p: any) => allow.has((p?.name || '').toLowerCase()))
    }
    if ((script_type === 'hook' || script_type === 'joined') && shapes.length === 0) {
      return json({ error: 'no hook_shapes match the requested filter' }, 400)
    }
    if ((script_type === 'body' || script_type === 'joined') && skeletons.length === 0) {
      return json({ error: 'no body_skeletons match the requested length bucket' }, 400)
    }

    const shapeRotation = (script_type === 'hook' || script_type === 'joined')
      ? planShapeRotation(shapes, n_concepts) : []

    const angleCtx = buildAngleContext(angle, proofs, mechanism)
    const shapesBlock = (script_type === 'hook' || script_type === 'joined')
      ? `\n\nHOOK SHAPES AVAILABLE:\n${buildHookShapesBlock(shapes)}` : ''
    const skeletonsBlock = (script_type === 'body' || script_type === 'joined')
      ? `\n\nBODY SKELETON:\n${buildBodySkeletonsBlock(skeletons)}` : ''
    const rotationBlock = shapeRotation.length
      ? `\n\nSHAPE ROTATION PLAN (the ${n_concepts} ${script_type === 'joined' ? 'joined scripts' : 'hooks'} you return MUST use these shape codes in this order, one per concept):\n${shapeRotation.map((c, i) => `  ${i + 1}. Shape ${c}`).join('\n')}\nProof character rotation: cycle through the proof characters listed above so we don't get 5 Metros in a row.`
      : ''

    const typeSpecificInstructions =
      script_type === 'hook'
        ? `Each hook is a SINGLE PARAGRAPH (no body, no CTA tee-up). It opens with the angle's qualifier (you may rephrase slightly per shape), states the promise + mechanism, includes the assigned shape's signature opening move, and closes with the guarantee. Length: 60-90 words. The hook must be standalone — an editor will pair it with a body later.`
        : script_type === 'body'
          ? `Each body follows the 7-beat skeleton above. Use the angle's CTA tee-up shape for Beat 1. Beat 2 (pattern statement) is where you vary stylistically across the ${n_concepts} concepts. Beats 3 (proof roster), 4 (mechanism reveal), 5 (3-part HOW), 6 (guarantee), and 7 (final CTA) follow the skeleton tightly. Length: 250-380 words. Do NOT include a hook — bodies are standalone too.`
          : `Each joined script is HOOK + BODY chained. Write the hook FIRST using the rotation's assigned shape, then write a body that explicitly continues from THAT hook's proof character + opening posture (don't switch proof characters between hook and body). Return them as separate strings (hook_text + body_text) and also as the combined body field. Length: 350-470 words total.`

    const userMsg = [
      angleCtx,
      shapesBlock,
      skeletonsBlock,
      rotationBlock,
      `\n\nGenerate exactly ${n_concepts} ${script_type === 'joined' ? 'joined scripts' : (script_type === 'hook' ? 'hooks' : 'bodies')} for this angle.`,
      `\n${typeSpecificInstructions}`,
      `\nReturn via the ${TEMPLATE_TOOL_NAMES[script_type]} tool.`,
      extraBlock,
    ].join('')

    const shapeCodes = shapes.map(s => s.code)
    const tool = buildTemplateToolSchema(script_type, n_concepts, shapeCodes.length ? shapeCodes : ['_'])

    const upstreamT = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4000 + n_concepts * 700,
        system: SYSTEM_PROMPT,    // existing locked principles still layer in
        messages: [{ role: 'user', content: userMsg }],
        tools: [tool],
        tool_choice: { type: 'tool', name: TEMPLATE_TOOL_NAMES[script_type] },
      }),
    })
    if (!upstreamT.ok) {
      const errText = await upstreamT.text()
      return json({ error: `Anthropic ${upstreamT.status}: ${errText.slice(0, 400)}` }, 502)
    }
    const resultT = await upstreamT.json()
    const toolUseT = (resultT.content || []).find((c: any) => c.type === 'tool_use')
    if (!toolUseT) return json({ error: 'Claude did not return a tool_use block', raw: resultT }, 502)
    const scriptsT = toolUseT.input?.scripts || []

    // Optional save-as-drafts. For hook/body/joined we tag the type so the
    // library system can later link generated scripts to recorded clips of
    // the matching type ('Hook', 'Body', 'Joined').
    let saved_variant_ids_t: string[] | undefined
    let save_error_t: string | undefined
    if (save_as_drafts && scriptsT.length) {
      const typeMap: Record<string, string> = { hook: 'Hook', body: 'Body', joined: 'Joined' }
      const inserts = scriptsT.map((s: any) => ({
        offer_slug: angle.offer_slugs?.[0] || null,
        angle_slug,
        mechanism_slug: mechanism_slug || null,
        script_type: typeMap[script_type] || script_type,
        ref: s.ref,
        title: `${typeMap[script_type] || script_type} via ${angle.slug}${mechanism ? ' × ' + mechanism.slug : ''} (shape ${s.shape_code || '—'})`,
        frame: script_type === 'body' ? 'OUTCOME' : 'OUTCOME',
        body: s.body,
        target_attributes: {
          shape_code: s.shape_code || null,
          proof_character: s.proof_character || null,
          length_bucket: target_length || null,
        },
        generated_by_model: ANTHROPIC_MODEL,
        generation_params: { angle_slug, mechanism_slug, script_type, target_shapes, n_concepts },
      }))
      const { data, error } = await supabase.from('generated_scripts').insert(inserts).select('id')
      if (error) save_error_t = error.message
      else if (data) saved_variant_ids_t = data.map((r: any) => r.id)
    }

    return json({
      ok: true,
      mode: 'template',
      script_type,
      angle: { slug: angle.slug, name: angle.name },
      mechanism: mechanism ? { slug: mechanism.slug, name: mechanism.name } : null,
      shape_rotation: shapeRotation,
      scripts: scriptsT,
      saved_variant_ids: saved_variant_ids_t,
      save_error: save_error_t,
      model: ANTHROPIC_MODEL,
    })
  }

  // ── Legacy offer-based path (unchanged) ──
  if (!offer_slug) return json({ error: 'offer_slug or (script_type + angle_slug) required' }, 400)

  // Normalize target_attributes — accept either string or string[] per key.
  // Arrays mean "include any of these values". Empty means "any/varied".
  const target_attributes: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(target_attributes_raw)) {
    if (Array.isArray(v) && v.length) target_attributes[k] = v as string[]
    else if (typeof v === 'string' && v) target_attributes[k] = [v]
  }
  const has_any_filter = Object.keys(target_attributes).length > 0

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  let offer: any, vocab: Record<string, string[]>, winners: any[]
  try {
    [offer, vocab, winners] = await Promise.all([
      loadOffer(supabase, offer_slug),
      loadVocab(supabase),
      loadWinnerPatterns(supabase, offer_slug),
    ])
  } catch (e: any) {
    return json({ error: e.message }, 500)
  }

  const winnerContext = winners.length
    ? `\nWINNING ATTRIBUTE PATTERNS (last 60 days for this offer, ≥2 winners each):\n${winners.map((w: any) =>
        `- ${w.attribute_name}=${w.attribute_value}: appears in ${w.winners} winners, avg cost-per-booked $${(w.avg_cost_per_booked || 0).toFixed(0)}`
      ).join('\n')}\nBias toward these patterns unless the user's target_attributes override.`
    : '\nNO WINNING-ATTRIBUTE DATA YET for this offer. Apply locked principles fresh.'

  const targetContext = has_any_filter
    ? `\nUSER-REQUESTED TARGET ATTRIBUTES (the scripts MUST distribute across these values — NOT all on one value, varied across them):\n${
        Object.entries(target_attributes).map(([k, v]) =>
          v.length === 1
            ? `- ${k}: must be "${v[0]}"`
            : `- ${k}: vary across [${v.join(', ')}] across the ${n_concepts} scripts`
        ).join('\n')
      }\nWithin those constraints, vary ALL OTHER attributes maximally so we get a wide testing matrix.`
    : `\nNO USER-REQUESTED TARGETS — DIVERSE BATCH MODE. Vary EVERY attribute maximally across the ${n_concepts} scripts:\n- hook_type: mix question / scene / dollar_pain / diagnostic / conditional\n- message_frame: balance PROBLEM / CIRCUMSTANCE / OUTCOME\n- mechanism_reveal: mix gated / explicit / hidden\n- pain_angle: rotate across the pod concepts (phone_not_ringing, agency_burn, tpa_referral_dep, capacity_mismatch, lead_platform, storm_seasonal, scaling_growth, speed_timeline, guarantee_proof, founder_identity, commercial_tier, adjuster_relations, competitor_takeover, last_objection)\n- funnel_stage: mix tof / mof / bof\n- proof_character: rotate across the available proof characters; only use 'none' if absolutely required\n- length_bucket: mix under_60s / sixty_75s / over_75s\nThe goal: produce a testing matrix where every script has a different combination of attributes. Maximize variance.`

  const userMsg = [
    `OFFER: ${offer.name} (slug: ${offer.slug})`,
    `VERTICAL: ${offer.vertical}`,
    `MECHANISM: ${offer.mechanism_name || '(none defined)'}`,
    `PRIMARY AUDIENCE: ${offer.primary_audience || '(none defined)'}`,
    `DEFAULT PROOF CHARACTERS: ${(offer.default_proof_characters || []).join(', ') || '(none)'}`,
    `DUAL GUARANTEE: ${offer.has_dual_guarantee ? 'YES — use the dual-guarantee close' : 'NO — use single-guarantee close'}`,
    offer.brand_voice_md ? `\nBRAND VOICE NOTES:\n${offer.brand_voice_md}` : '',
    winnerContext,
    targetContext,
    `\nGenerate exactly ${n_concepts} script concepts. Return via the generate_scripts tool.`,
    extraBlock,
  ].filter(Boolean).join('\n')

  const tool = buildToolSchema(vocab, n_concepts, offer.default_proof_characters || [])

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4000 + n_concepts * 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
      tools: [tool],
      tool_choice: { type: 'tool', name: 'generate_scripts' },
    }),
  })
  if (!upstream.ok) {
    const errText = await upstream.text()
    return json({ error: `Anthropic ${upstream.status}: ${errText.slice(0, 400)}` }, 502)
  }
  const result = await upstream.json()
  const toolUse = (result.content || []).find((c: any) => c.type === 'tool_use')
  if (!toolUse) return json({ error: 'Claude did not return a tool_use block', raw: result }, 502)

  const scripts = toolUse.input?.scripts || []

  // Optional: save as variant drafts
  let saved_variant_ids: string[] | undefined
  let save_error: string | undefined
  if (save_as_drafts && scripts.length) {
    const inserts = scripts.map((s: any) => ({
      offer_slug,
      ref: s.ref,
      title: s.title,
      frame: s.frame,
      body: s.body,
      target_attributes: {
        hook_type: s.hook_type,
        mechanism_reveal: s.mechanism_reveal,
        pain_angle: s.pain_angle,
        proof_character: s.proof_character,
        awareness_level: s.awareness_level,
        funnel_stage: s.funnel_stage,
        length_bucket: s.length_bucket,
      },
      generated_by_model: ANTHROPIC_MODEL,
      generation_params: { offer_slug, n_concepts, target_attributes },
    }))
    const { data, error } = await supabase.from('generated_scripts').insert(inserts).select('id')
    if (error) {
      // Surface to caller — don't swallow. Scripts still returned in payload
      // so operator can copy them; just couldn't persist to drafts.
      save_error = error.message
    } else if (data) {
      saved_variant_ids = data.map((r: any) => r.id)
    }
  }

  return json({
    ok: true,
    offer: { slug: offer.slug, name: offer.name, vertical: offer.vertical },
    scripts,
    saved_variant_ids,
    save_error,
    model: ANTHROPIC_MODEL,
  })
 } catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error('creative-generate-script unhandled:', msg)
  return json({ error: `generator crashed: ${msg.slice(0, 300)}` }, 500)
 }
})
