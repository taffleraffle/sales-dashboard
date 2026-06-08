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
// Angle generation is structured tool-use output — Haiku is ~3x faster
// throughput at this task with no meaningful quality drop. Override per
// the operator's "this should be fast" complaint (Ben 2026-06-01).
const ANTHROPIC_ANGLE_MODEL = Deno.env.get('ANTHROPIC_ANGLE_MODEL') || 'claude-haiku-4-5-20251001'
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

9. CTA STRUCTURE — End with one clear conditional CTA + the guarantee. For dual-guarantee offers: "[Outcome 1] in 90 days. [Outcome 2] in 90 days. Money back if neither happens. Tap below." For single-guarantee: "Crews booked from direct homeowner calls in 90 days. Money back if not. Tap below."

10. REALITY-CHECK / NO-INVENTED-CAPABILITIES (Ben 2026-06-01 PM — generic, mechanism-aware version). Every promise in the script must trace to the offer's NAMED MECHANISM as described in the angle context above. Don't invent capabilities the current offer doesn't deliver just to fit the angle's wording. Equally, don't refuse to claim capabilities the offer DOES describe — if a future offer's mechanism says "we manage carrier-vendor relationships", the script is free to claim that.

   How to check: read the offer's mechanism_short + mechanism_long in the angle context — that's the LEVER this offer pulls. Whatever the script promises must be reachable via that lever. If the angle's wording implies an outcome the lever can't reach (e.g. an angle called "Insurance Carrier Insider Status" being run against an offer whose mechanism is purely Google-visibility), REFRAME the angle's underlying desire through the mechanism the offer actually has. End-state for the prospect stays the same (they get the high-value calls they wanted) — the LEVER your script names is the one the offer can actually pull.

   Worked reframe (Google-visibility offer × Carrier Insider angle): "You don't get on the inside by chasing the carrier. You get on the inside by being the company homeowners already picked. Once you're the #1 Google result, the adjuster's just paperwork — they're approving the company the homeowner picked." Same end-state (be the obvious choice for the high-value job), real lever (Google search visibility).

   FINAL SELF-CHECK before returning: re-read your script's promise + CTA. Ask "could this offer's mechanism, as described in the angle context, actually produce this outcome?" If yes, ship. If no — even if the angle's title implies it — rewrite the promise through the mechanism that's actually real for THIS offer. The constraint travels with the offer, not with the wording.

11. VOICE — 5TH-GRADE READING LEVEL + TALK-TO-A-FRIEND (Ben 2026-06-01, after seeing scripts read like academic reports).
   Treat this like Alex Hormozi's $100M Hooks Playbook. Write the way you'd actually talk to a friend who happens to own a restoration company over a beer — not the way a copywriter writes for a brand. Rules:

   a) READING LEVEL: target a 5th-grade reading level. If a 10-year-old wouldn't get the word, don't use it. HARD BANNED (every occurrence is a defect — do a final pass to remove these): "dependency" (say "depending on" / "stuck on"), "engineered" (say "we built" / "we set up"), "optimize" / "optimized" / "optimizing" / "optimization" (say "fix" / "tune up" / "rebuild"), "leverage", "utilize", "implement", "facilitate", "methodology", "architecture", "infrastructure", "topical authority" (say "Google trusts you on the topic"), "preferred-vendor API" (say "their secret vendor list" / "their internal app"), "service radius weighting" (say "how big an area Google shows you in"), "review velocity" / "velocity signals" (say "how fast new reviews come in"), "proximity algorithm" (say "how close you are to the search"), "systematic application", "burnout rate" (say "burn out and leave"), "ranking factor" (say "ranking signal" or just "what Google looks at"), "asymmetric" / "asymmetry", "pipeline" (in business sense — say "calls" / "leads" / "the flow of work"), "vertical" (say the actual industry name), "ascension", "iteration", "saturation" (say "everyone's doing it"), "calibrate", "stack" (as verb), "monetize", "scalability", "consolidate", "operationalize", "framework" (just say "system"). FINAL CHECK before returning: scan your draft for any of these — if found, rewrite in plain words. Use the actual word a restoration owner would say at a job site.

   b) SENTENCE LENGTH: short. Most sentences 6-14 words. Fragments are fine. Two-word punches are fine. ("It works." "Three days." "Money back."). Long sentences should be rare — and when you write one, it should earn its length with rhythm. No "Here's what 73% of restoration owners don't realize until it's too late: adjuster dependency has an 18-month burnout rate" — that's a research paper sentence. Rewrite as: "Most adjusters move on in under two years. Then your phone goes quiet. Travis lost his guy in February."

   c) RHYTHM: vary sentence length deliberately. Long. Short. Short. Long. Short. Like Hormozi. Like a podcast host. Like you're explaining something at a bar. The cadence is what makes it engaging — even when the information is the same.

   d) FRIEND-TALK MARKERS: contractions everywhere ("you're", "they're", "it's", "we'll"). Second person throughout ("you", "your"). Direct address ("Here's the thing..." "Look..." "Listen..."). Imperfect grammar OK if it sounds natural. "Three things. One: ..." beats "First, ...".

   e) HORMOZI $100M HOOK FORMULAS — use these as PATTERNS (do not copy verbatim, write fresh in the angle's voice):
      • Identity + Pain + Promise: "If you're a restoration owner doing $50k+/mo and you're sick of [specific pain], here's the [specific fix]."
      • False Belief Pattern: "Most restoration owners think [false belief]. They're wrong. Here's what actually works."
      • Just Talked To Story: "Just got off the phone with [name]. He told me something wild about [topic]. Listen to this."
      • Numbered List Tease: "Three things winning restoration owners do differently. The third one's the kicker."
      • Stop Doing X / Do Y: "If you're a restoration owner, stop chasing [thing]. Here's what to do instead."
      • Curiosity Question: "How do some restoration guys book $100k/mo from Google while others spend the same on ads and get crickets?"

   f) WHAT THIS LOOKS LIKE IN PRACTICE — opening of the body Ben pasted as the GOOD example: "Your biggest adjuster just called. They're relocating to another state. The adjuster who fed you $40,000 in jobs every month for the last two years is gone. And you're staring at a calendar that went from booked solid to half-empty overnight." Notice: short sentences, second person, concrete numbers, scene-painted, no jargon. That's the register. The script's BAD half: "Here's what 73% of restoration owners don't realize until it's too late: adjuster dependency has an 18-month burnout rate. Most adjusters either move markets, change companies, or get promoted out of field work within 18 months." Notice: stat-paper opener, jargon ("dependency"), long winding sentence, no rhythm. Rewrite ALL beats in the good register. If a beat reads academic, rewrite it like you'd say it to a friend.

   g) SELF-CHECK BEFORE RETURNING: read your script out loud in your head. If any sentence sounds like a LinkedIn post, a press release, or a textbook — rewrite it shorter, with simpler words, more like a person actually talking. If the prospect reads it and thinks "this person GETS it" rather than "this is an ad" — you've hit the voice.`

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
    .select('name, result_short, result_long, industry_context, metric_kind, proof_type, display_order')
    .eq('angle_slug', angle_slug)
    .eq('active', true)
    .order('proof_type')
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

// Load winning-ad reference scripts (migration 143). The prompt assembly
// injects up to 3 active examples matching the run's script_mode +
// script_type so the model sees what good copy LOOKS LIKE without us
// having to hand-code restoration-flavoured examples into the prompt.
//
// Selection priority:
//   1. Examples scoped to this offer_slug exactly
//   2. Examples scoped to no offer (offer_slug IS NULL = applies across offers)
//   3. Most recent first within each tier
//
// Capped at 3 to keep prompt-size sane; Ben can prune/edit the table
// any time without redeploying this function.
async function loadScriptExamples(supabase: any, mode: string, script_type: string, offer_slug: string | null) {
  // Inputs are validated upstream but be defensive — bad mode shouldn't 502.
  if (!mode || !script_type) return []
  // script_type='joined' counts as 'hook_body' for the purpose of pulling
  // full-script references; an isolated hook or body still pulls hook_body
  // examples since most winners are full scripts and the model can extract
  // the relevant portion.
  const typeAlias = script_type === 'joined' ? ['hook_body'] : ['hook_body', script_type]
  let q = supabase
    .from('script_examples')
    .select('slug, title, body, mode, script_type, offer_slug, audience_label, notes')
    .eq('active', true)
    .eq('mode', mode)
    .in('script_type', typeAlias)
    .order('created_at', { ascending: false })
    .limit(20)   // pull a generous bucket, narrow down client-side
  const { data, error } = await q
  if (error) return []   // example fetch is best-effort — never block generation
  const rows = data || []
  // Sort: offer-specific first, then global. Stable within each tier.
  rows.sort((a: any, b: any) => {
    const aMatch = a.offer_slug === offer_slug ? 0 : (a.offer_slug ? 2 : 1)
    const bMatch = b.offer_slug === offer_slug ? 0 : (b.offer_slug ? 2 : 1)
    return aMatch - bMatch
  })
  return rows.slice(0, 3)
}

// Format the examples block for the prompt. Critical framing: these are
// PATTERNS to extract, NOT templates to copy. Without that the model
// borrows concrete details (mechanism names, client stories, specific
// numbers) that belong to the originals.
function formatScriptExamplesBlock(examples: any[], script_mode: string): string {
  if (!examples.length) return ''
  const sections = examples.map((ex, i) => {
    const audienceLine = ex.audience_label ? `Audience: ${ex.audience_label}\n` : ''
    const notesLine = ex.notes ? `\nWhat makes this work (operator notes):\n${ex.notes}\n` : ''
    return `═══ EXAMPLE ${i + 1} — ${ex.title} ═══\n${audienceLine}\nSCRIPT BODY:\n${ex.body}\n${notesLine}`
  }).join('\n\n')
  return `\n\n═══════════════════════════════════════════════════════════════
EDUCATIONAL EXAMPLES TO STUDY (${script_mode.toUpperCase()} MODE)
═══════════════════════════════════════════════════════════════

The scripts below are winning ads in the same MODE you're writing in.
They share a structural spine you should EXTRACT and APPLY to THIS
angle. They do NOT share the same offer, mechanism, audience, or
proof characters — those came from the original advertisers' worlds,
not from yours.

EXTRACT these patterns:
  - Opening shape (pattern-interrupt CLAIM vs qualifier-call-out vs
    trend-statement vs mistake-framing vs curiosity tease) — pick the
    shape that fits THIS angle, don't default to the same one every time
  - Where the QUALIFIER drops (beat 1 or beat 2) — early enough that
    out-of-band prospects self-deselect
  - PLAIN-WORDS mechanism reveal in the middle (NOT jargon — these
    examples explicitly avoid "algorithm" / "weighting" / "optimize")
  - ONE proof story with concrete numbers in 2-3 sentences max
    (NOT a roster of 4+ clients — one is enough)
  - The reframe that punctures the prospect's existing belief
    ("Google's algorithm doesn't think — it guesses" is the educational
    flip that makes the body convert)
  - Close shape: soft urgency + qualifier reinforcement + CTA

DO NOT borrow these specifics (they belong to the originals):
  - Mechanism names: "Get Found engine", "Maps Mastery system"
    → use THIS offer's actual mechanism (in the angle context above)
  - Revenue bands: "$25k+/mo", "$50k+/mo restoration"
    → use THIS angle's qualifier (verbatim, it's in the angle context)
  - Proof stories: "Phoenix dentist", "16 days to #1", "3 calls → 27"
    → use THE PROOF CHARACTERS listed for THIS angle (with their
    actual revenue / outcome / story from the proof rows)
  - Industry verticals named in the examples — write to THIS angle's
    vertical, full stop.

If your draft uses any of the example mechanism names, client stories,
or specific numbers verbatim, you've copied instead of studied —
rewrite with this offer's facts.
${sections}

═══ END EXAMPLES ═══
`
}

// Build the angle-context block that prefixes every template-based prompt.
// When mechanism is provided (migration 108), its short/long/3-part-HOW
// take precedence over the angle's legacy mechanism fields. This lets the
// same angle (problem/desire door) be paired with different mechanisms
// across campaigns without editing the angle row.
function buildAngleContext(angle: any, proofs: any[], mechanism: any = null, useMechanism: boolean = true): string {
  // Proof roster: group by proof_type so the rotation directive can ask
  // Claude to vary across kinds (Schwartz's hierarchy of proof — case
  // study, testimonial, statistic, authority, demonstration, social_volume,
  // comparison). Defaults to 'case_study' for any pre-migration-117 rows.
  const byType: Record<string, any[]> = {}
  for (const p of proofs) {
    const t = p.proof_type || 'case_study'
    if (!byType[t]) byType[t] = []
    byType[t].push(p)
  }
  const typeOrder = Object.keys(byType)
  const proofRoster = proofs.length
    ? typeOrder.map(t => {
        const items = byType[t].map((p, i) =>
          `   ${i + 1}. ${p.name} — ${p.result_short}${p.result_long ? `\n      long: "${p.result_long}"` : ''}${p.metric_kind ? ` [metric: ${p.metric_kind}]` : ''}`
        ).join('\n')
        return `  [${t.toUpperCase()}]\n${items}`
      }).join('\n')
    : '(no proof characters defined for this angle — generate WITHOUT naming any specific clients; use generic phrasing like "our clients" only if absolutely required, and prefer omitting proof entirely so the operator can drop a real win in later)'
  // Schwartz rotation directive — only fire when multiple proof types are
  // present, otherwise it's noise.
  const rotationDirective = typeOrder.length > 1
    ? `\nPROOF ROTATION DIRECTIVE: ${typeOrder.length} proof TYPES available (${typeOrder.join(', ')}). Across the concepts you produce, ROTATE across types — don't lean on case_study alone. Treat each type as a distinct mode of conviction: case_study persuades by specificity, testimonial by voice + identity, statistic by scale, authority by borrowed credibility, demonstration by show-not-tell, social_volume by aggregate weight, comparison by alternative-anchor. A 10-concept batch should touch at least ${Math.min(typeOrder.length, 4)} different types.`
    : ''
  const pains = angle.pain_points || []
  const painBlock = pains.length
    ? `\nPAIN POINTS (use these as the lived-reality of the prospect — Shape C "Pain anchor" hooks especially must lean on specific items from this list, NOT generic competitor language. Other shapes can reference one or two of these as supporting context):\n${pains.map((p: string) => `  - ${p}`).join('\n')}`
    : ''
  // Mechanism precedence: explicit mechanism > angle's legacy fields.
  // When the operator toggled "No mechanism" off (useMechanism=false),
  // all mech_* / mechBlock / howBlock collapse to empty so the prompt
  // never names a branded mechanism. The angle's primary_promise +
  // guarantee_close still carry through — the script just delivers the
  // capability in plain language without the brand name.
  const mech_short = useMechanism ? (mechanism?.mechanism_short || angle.mechanism_short) : ''
  const mech_long  = useMechanism ? (mechanism?.mechanism_long  || angle.mechanism_long)  : ''
  const mechBlock = (useMechanism && mechanism)
    ? `\nMECHANISM PICKED: ${mechanism.name}${mechanism.summary ? ' — ' + mechanism.summary : ''}`
    : ''
  const howBlock = (useMechanism && (mechanism?.beat_5a || mechanism?.beat_5b || mechanism?.beat_5c))
    ? `\n3-PART HOW (use these as Beat 5a / 5b / 5c in the body skeleton — one sentence each, in order):\n  5a: ${mechanism.beat_5a || '(unset)'}\n  5b: ${mechanism.beat_5b || '(unset)'}\n  5c: ${mechanism.beat_5c || '(unset)'}`
    : ''
  const noMechanismDirective = !useMechanism
    ? `\nMECHANISM OFF (operator toggle 2026-06-01 PM): Do NOT name a branded mechanism or system in any concept. Describe what we do in PLAIN LANGUAGE only ("we rebuild your Google profile and tune your service pages", NOT "we run the Direct Call Engine"). The capability is the same — the brand-naming layer is suppressed. This applies to hook, body, and joined scripts equally.`
    : ''
  // Schwartz awareness-stage diversity directive — applies to every angle
  // context regardless of proof state. Asks the generator to consider where
  // each script's reader sits on the unaware→most-aware continuum and to
  // vary across the batch.
  const awarenessBlock = `
SCHWARTZ DIVERSITY (apply across the batch, NOT to every individual script):
- AWARENESS STAGE: rotate scripts across (a) Problem-Aware — reader knows the pain but no solution yet; (b) Solution-Aware — reader knows solutions exist but not your mechanism; (c) Product-Aware — reader knows your mechanism but isn't convinced it's for them; (d) Most-Aware — reader is already comparing OPT to alternatives and needs a final push. A 10-script batch should include AT LEAST one from each of (a)/(b)/(c).
- SOPHISTICATION LEVEL: the more "this category is well-worn" the prospect feels, the stronger the unique mechanism + bigger the promise must be. For tired markets (HomeAdvisor era restoration, Bench-era bookkeeping), lean Stage 4-5 — name the mechanism + a sharper promise. For greener pockets, Stage 2-3 is fine — basic claim + proof.
- MASS DESIRE: every concept must connect to a pre-existing dominant emotion the prospect ALREADY has — not invent a new one. Surface the desire that's already burning, then channel it.`
  return [
    `ANGLE: ${angle.name}`,
    `QUALIFIER (the audience-filter opening line shape): ${angle.qualifier}`,
    `PRIMARY PROMISE (every script must deliver on exactly this): ${angle.primary_promise}`,
    mech_short ? `MECHANISM (short, for hook use): ${mech_short}` : '',
    mech_long ? `MECHANISM (long, for body reveal beat 4): ${mech_long}` : '',
    mechBlock,
    howBlock,
    noMechanismDirective,
    `GUARANTEE CLOSE: ${angle.guarantee_close}`,
    angle.cta_teeup ? `CTA TEE-UP (body beat 1 opener template): ${angle.cta_teeup}` : '',
    angle.anchor_vocab?.length ? `ANCHOR VOCAB (rotate so anchors don't become a structural tic): ${angle.anchor_vocab.join(' · ')}` : '',
    painBlock,
    '',
    `PROOF SOURCES (you may name only these, in only these forms — grouped by Schwartz proof type. Use them as written; do not invent new specific results or clients):`,
    proofRoster,
    rotationDirective,
    awarenessBlock,
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

function buildTemplateToolSchema(script_type: string, n: number, shape_codes: string[], proof_names: string[] = []) {
  const hasProofs = proof_names.length > 0
  const itemBase: any = {
    type: 'object',
    properties: {
      ref:    { type: 'string', description: 'short sequential reference like H1, H2, ...' },
      body:   { type: 'string', description: 'the script text. Plain text, paragraph breaks for sentence groups, NO markdown' },
      proof_character: hasProofs
        ? { type: 'string', enum: proof_names, description: `the named proof character this concept anchors on. REQUIRED — must be one of: ${proof_names.join(', ')}. The body text MUST mention this character by first name. Generic phrasing like "one client" / "a third client" is banned.` }
        : { type: 'string', description: 'which proof character name is used in this script, exactly as listed in the angle context (no proofs are defined for this angle — leave blank or omit)' },
      teach_focus: { type: 'string', description: 'one short phrase naming the specific lesson THIS concept teaches the prospect (must differ from other concepts in the batch — e.g. "why rank-1 captures 78% of clicks", "what the LSA algorithm actually weighs", "how the 3-part fix sequences")' },
      notes:  { type: 'string', description: 'one-line note on why this concept' },
    },
    required: ['ref', 'body'],
  }
  if (hasProofs) {
    itemBase.required.push('proof_character')
  }
  if (n > 1) {
    itemBase.required.push('teach_focus')
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
    description: `Return exactly ${n} ${script_type} concepts.${n > 1 ? ' Each concept must use a DIFFERENT proof character + DIFFERENT teach focus — see the concept-variance directive in the user message.' : ''}`,
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

WHAT'S CONVERTING for OPT right now (Ben 2026-06-01) — RANK-EXPLICIT, BOTTOM-OF-FUNNEL desires:
OPT's best-performing angles are outcome-explicit, vertical-named, rank-anchored desires. Be specific about WHICH rank (Maps top-3 vs AI citation vs Local Service Ads vs organic position 1) — the bluntness IS the conversion edge.

CORE RANK-EXPLICIT DESIRE FAMILIES (use these as templates; substitute the actual vertical + city/area in the prospect_voice):
  • Maps top-3:  "I want to rank in the top 3 Google Maps results for [service] in [city]." / "I want to own the local pack for [vertical] in [area]."
  • Map pin #1:  "I want to be the first pin every homeowner in [city] sees when they Google '[service] near me'."
  • AI citation: "I want to be the company ChatGPT names when someone asks 'best [vertical] in [city]'." / "I want to be the AI-recommended [vertical] in [area]." / "I want to show up when prospects ask Perplexity / Gemini / Claude for a [vertical]."
  • LSA dominance: "I want my Local Service Ads to outrank every other [vertical] in [zip]." / "I want the Google Guaranteed badge to be the first thing prospects see for [service]."
  • Organic SERP: "I want page-one organic for '[service] [city]' so I'm not paying for every click." / "I want the featured snippet when someone searches '[service] cost in [city]'."
  • Review velocity: "I want enough reviews to bury the competition in Maps." (rank-adjacent — review volume is a Maps ranking factor)
  • Brand recall: "I want to be the only [vertical] name people remember in [area]."

MECHANISM-FRUSTRATION DESIRES (also high-converting — "I'm tired of X and want Y"):
  • "I want my ads to actually convert instead of burning $5K/month on shared HomeAdvisor leads."
  • "I want the predictable booking calendar HomeAdvisor promised but never delivered."
  • "I want to fire my SEO agency that's been charging me $2k/mo for two years with nothing to show."
  • "I want exclusive leads, not the same lead sold to 4 other [vertical] companies."
  • "I want to stop being held hostage by Yelp's pay-to-play."

VERTICAL-AWARENESS NOTES — calibrate which families to lean into per the offer's vertical:
  • RESTORATION (water damage, fire, mold, biohazard): VERY rank-aware. Emergency leads = revenue. Lean heavily on Maps top-3, LSA, AI-citation, and HomeAdvisor / TPA frustration. These owners explicitly want rank-1 because they know the ROI per call.
  • ROOFING: VERY rank-aware, especially storm-driven markets. Maps + LSA + storm-season SERP. Hail/wind triggers searches.
  • PLUMBING / HVAC / ELECTRICAL: VERY rank-aware (emergency vertical). Same dynamic as restoration. License-required + emergency = high-intent leads.
  • PEST CONTROL / LOCKSMITH / GARAGE DOOR: rank-aware (emergency-ish), Maps-dominant.
  • DENTAL / VETERINARY / MED-SPA: moderately rank-aware. Maps + organic both matter. Local pack desire is real but secondary to reputation/reviews.
  • ACCOUNTING / CPA / LAW (non-PI): LESS rank-aware. Referral-driven. The "I want to rank #1" desire is weaker; the "I want to be the firm bankers refer" or "I want LinkedIn authority" desire is stronger. Use referral-network + authority-positioning desires here, NOT Maps top-3.
  • E-COMMERCE / D2C: not local-rank focused. Skip the Maps angle entirely; lean on ROAS, CAC, paid social efficiency desires.
  • B2B SAAS: completely different game. No local-rank desires.

DISTRIBUTION RULE: For verticals tagged HIGH rank-aware (restoration, roofing, plumbing, HVAC, electrical, pest, locksmith, garage), at least 40% of the DESIRE batch should be rank-explicit. For MODERATE rank-aware (dental, vet, med-spa), 20%. For LOW (CPA, law non-PI, B2B), skip rank desires entirely and substitute the vertical-appropriate authority desire.
The rest of the desire batch should span Problem-Aware and Solution-Aware tiers so the operator has range.

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

// Vertical rank-awareness tiers (Ben 2026-06-01). Used to pick how many
// rank-explicit outcomes the generator must produce.
//   HIGH    — emergency / local-pack-driven verticals. 40% of outcomes rank-explicit.
//   MODERATE — local-relevant but reputation-driven. 20% rank-explicit.
//   LOW     — referral / authority / B2B. 0% rank-explicit (substitute authority desires).
//   SKIP    — not local-rank at all (e-commerce, B2B SaaS).
function classifyRankAwareness(vertical: string | null | undefined): 'HIGH' | 'MODERATE' | 'LOW' | 'SKIP' {
  const v = (vertical || '').toLowerCase().trim()
  if (!v) return 'MODERATE'   // unknown — middle tier is safest default
  const HIGH = ['restoration', 'water damage', 'mit', 'mitigation', 'fire damage', 'mold', 'biohazard',
                'roofing', 'roof', 'plumbing', 'plumber', 'hvac', 'electrical', 'electrician',
                'pest', 'locksmith', 'garage door', 'garage', 'concrete', 'foundation', 'septic',
                'tree service', 'fence', 'painting']
  const MODERATE = ['dental', 'dentist', 'veterinary', 'vet', 'med spa', 'medspa', 'chiropractor',
                    'gym', 'fitness', 'realtor', 'real estate', 'mortgage', 'insurance broker',
                    'auto repair', 'mechanic', 'auto detail']
  const LOW = ['accounting', 'cpa', 'bookkeeping', 'law', 'lawyer', 'attorney', 'attorneys',
               'consulting', 'coaching', 'fractional']
  const SKIP = ['ecommerce', 'e-commerce', 'd2c', 'saas', 'b2b saas', 'agency', 'marketing agency']
  for (const k of HIGH) if (v.includes(k)) return 'HIGH'
  for (const k of MODERATE) if (v.includes(k)) return 'MODERATE'
  for (const k of LOW) if (v.includes(k)) return 'LOW'
  for (const k of SKIP) if (v.includes(k)) return 'SKIP'
  return 'MODERATE'
}

// Given a target outcome count + the rank-awareness tier, return the
// REQUIRED minimum number of rank-explicit outcomes. The schema enforces
// this via a separate sub-bucket so Claude can't silently dodge it.
function requiredRankExplicit(n_outcomes: number, tier: ReturnType<typeof classifyRankAwareness>): number {
  if (tier === 'SKIP') return 0
  if (tier === 'LOW') return 0
  // MODERATE bumped 0.2 -> 0.3 (Ben 2026-06-01 — rank framing converts even for
  // reputation-driven verticals once you anchor on local-pack visibility).
  if (tier === 'MODERATE') return Math.min(n_outcomes, Math.max(1, Math.ceil(n_outcomes * 0.3)))
  // HIGH bumped 0.4 -> 0.6 (Ben 2026-06-01 — "I want some that are a bit more
  // like maps, really like being the number one company in your area, because
  // that is ranking and working really well for us"). For HIGH-tier verticals
  // (restoration, roofing, plumbing, HVAC, electrical, pest, locksmith,
  // garage, painting, concrete, foundation), the BOFU rank-explicit
  // outcomes carry the conversion load. 60% floor.
  return Math.min(n_outcomes, Math.max(3, Math.ceil(n_outcomes * 0.6)))
}

// Build a tool schema for a SINGLE-BUCKET angle generation call
// (Ben 2026-06-01 — split from the prior all-buckets-in-one design
// because single calls of 13+ angles were timing out the Edge Function
// at the 60s connection limit). bucket = the only angle_type Claude
// is allowed to return for this call.
function buildSingleBucketAngleToolSchema(
  bucket: 'problem' | 'circumstance' | 'outcome',
  count: number,
  groundingCount: number,
  rankMinForBucket: number,
) {
  const angleItem = {
    type: 'object',
    properties: {
      angle_type: { type: 'string', enum: [bucket],
        description: `Always "${bucket}" for this call.` },
      rank_explicit: { type: 'boolean',
        description: bucket === 'outcome'
          ? `TRUE only if this OUTCOME uses literal rank/visibility framing — "rank #1", "top 3 on Maps", "first pin", "AI-recommended", "the company ChatGPT names", "LSA dominance", "page-one organic", "outrank every other [vertical]". At least ${rankMinForBucket} of the ${count} outcomes MUST be true.`
          : 'Always FALSE for problem and circumstance angles.' },
      name: { type: 'string', description: 'Short title (3-7 words).' },
      prospect_voice: { type: 'string', description: 'First-person voice, 1 sentence.' },
      pain_points: { type: 'array', items: { type: 'string' },
        description: '2-4 specific lived-reality details.' },
      hook_build_sketch: { type: 'string',
        description: 'ONE LINE: shape + first 12-20 words of how the hook would open.' },
      why_it_matters: { type: 'string',
        description: 'PROSE 4-6 sentences. Consequences + deeper anxiety + what they\'ve tried.' },
      evidence_examples: { type: 'array', items: { type: 'string' },
        description: '2-3 concrete situational moments. Specific scenes, not summaries.' },
      sources: groundingCount > 0
        ? {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer', description: `1-based index into GROUNDING SOURCES (1-${groundingCount}).` },
                relevance: { type: 'string', description: 'One sentence on what this source contributed.' },
              },
              required: ['index', 'relevance'],
            },
            description: 'Cite ONLY sources you actually drew from. Empty array if reasoning-only. Never invent.',
          }
        : {
            type: 'array',
            items: { type: 'object', properties: {}, additionalProperties: false },
            description: 'No grounding. Return empty array.',
            maxItems: 0,
          },
    },
    required: ['angle_type', 'rank_explicit', 'name', 'prospect_voice', 'hook_build_sketch', 'why_it_matters', 'evidence_examples', 'sources'],
  }
  return {
    name: ANGLE_TOOL_NAME,
    description: `Return exactly ${count} ${bucket} angles.${bucket === 'outcome' && rankMinForBucket > 0 ? ` At least ${rankMinForBucket} must have rank_explicit=true.` : ''}`,
    input_schema: {
      type: 'object',
      properties: {
        angles: { type: 'array', items: angleItem, minItems: count, maxItems: count },
      },
      required: ['angles'],
    },
  }
}

function buildAngleToolSchema(
  n_problems: number,
  n_circumstances: number,
  n_outcomes: number,
  groundingCount: number,
  rankTier: ReturnType<typeof classifyRankAwareness>,
) {
  const allowedTypes = ['problem', 'circumstance', 'outcome']
  const total = n_problems + n_circumstances + n_outcomes
  const rankMin = requiredRankExplicit(n_outcomes, rankTier)
  const angleItem = {
    type: 'object',
    properties: {
      angle_type: { type: 'string', enum: allowedTypes,
        description: 'problem = pain the prospect is stuck on. circumstance = identity/situation moment (e.g. "I just hired my third tech and there is not enough work to keep them busy"). outcome = the end-state they want (e.g. "I want to be the #1 water damage company in Houston on Maps"). Return problems first, then circumstances, then outcomes.' },
      rank_explicit: { type: 'boolean',
        description: `TRUE only if this is an OUTCOME angle that uses a literal rank/visibility framing — phrases like "rank #1", "top 3 on Maps", "first pin", "AI-recommended", "the company ChatGPT names", "Local Service Ads dominance", "page-one organic", "outrank every other [vertical]". FALSE otherwise (always FALSE for problem and circumstance angles). The batch MUST contain at least ${rankMin} OUTCOMES with rank_explicit=TRUE${rankTier === 'HIGH' ? ' — this is a HIGH rank-aware vertical and the operator has explicitly asked for rank-#1 angles to surface' : ''}.` },
      name: {
        type: 'string',
        description: 'Short title (3-7 words) summarizing the angle. Displayed in the picker.',
      },
      prospect_voice: {
        type: 'string',
        description: 'Angle phrased in the prospect\'s own first-person voice, 1 sentence. PROBLEM example: "I can\'t hire a senior accountant for love or money." CIRCUMSTANCE example: "I just brought on my third tech and now there\'s not enough work to give them." OUTCOME example: "I want to be the first Maps pin every homeowner in Houston sees for water damage."',
      },
      pain_points: {
        type: 'array',
        items: { type: 'string' },
        description: '2-4 specific lived-reality details that make this angle visceral. E.g. for the bookkeeping pain: ["watching Bench cold-pitch $300/mo clients", "QBO Live offering software-plus-human at half my price"]. For outcomes: the supporting facts that make the desire feel earnable.',
      },
      hook_build_sketch: {
        type: 'string',
        description: 'ONE LINE: which shape fits + first 12-20 words of how the hook would open. Format: "Shape C (Pain anchor). Opens \\"If you run a CPA firm doing $50k a month and you\'re watching Bench cold-pitch your bookkeeping clients...\\""',
      },
      why_it_matters: {
        type: 'string',
        description: 'PROSE PARAGRAPH (4-6 sentences). For PROBLEMS: consequences of not solving + deeper anxiety + what they tried. For CIRCUMSTANCES: why this moment is decision-forcing (what they about to lose / gain). For OUTCOMES: what changes when they get there + what they have to believe to chase it.',
      },
      evidence_examples: {
        type: 'array',
        items: { type: 'string' },
        description: '2-3 CONCRETE SITUATIONAL MOMENTS where this angle bites. Specific scenes, not summaries.',
      },
      sources: groundingCount > 0
        ? {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer', description: '1-based index into the GROUNDING SOURCES block in the user message.' },
                relevance: { type: 'string', description: 'One sentence on what this source contributed.' },
              },
              required: ['index', 'relevance'],
            },
            description: `Cite the GROUNDING SOURCES (1-${groundingCount}) you actually used while writing this angle. Empty array if reasoning-only. Never invent sources.`,
          }
        : {
            type: 'array',
            items: { type: 'object', properties: {}, additionalProperties: false },
            description: 'No grounding sources provided. Return empty array.',
            maxItems: 0,
          },
    },
    required: ['angle_type', 'rank_explicit', 'name', 'prospect_voice', 'hook_build_sketch', 'why_it_matters', 'evidence_examples', 'sources'],
  }
  return {
    name: ANGLE_TOOL_NAME,
    description: `Return exactly ${n_problems} problems + ${n_circumstances} circumstances + ${n_outcomes} outcomes. At least ${rankMin} of the outcomes MUST have rank_explicit=true (rank-#1 / top-3 / AI-recommended / Maps-pin framing).`,
    input_schema: {
      type: 'object',
      properties: {
        angles: {
          type: 'array',
          items: angleItem,
          minItems: total,
          maxItems: total,
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
  // Script mode (Ben 2026-06-01, ROM added 2026-06-09) —
  // 'direct' | 'hybrid' | 'educational' | 'rom'.
  // Falls through to 'direct' (the legacy behavior) when caller omits.
  const script_mode: 'direct' | 'hybrid' | 'educational' | 'rom' =
    body?.script_mode === 'educational' ? 'educational'
    : body?.script_mode === 'hybrid' ? 'hybrid'
    : body?.script_mode === 'rom' ? 'rom'
    : 'direct'
  // Mechanism toggle (Ben 2026-06-01 PM). Default TRUE so legacy callers
  // (omitting the field) keep the existing branded-mechanism behavior.
  // Only an explicit false strips the mechanism from the prompt context.
  const use_mechanism: boolean = body?.use_mechanism === false ? false : true
  const extraBlock = extra_instructions
    ? `\n\nOPERATOR INSTRUCTIONS FOR THIS RUN (these take precedence over generic defaults; honor them literally):\n${extra_instructions}\n`
    : ''

  // ── BRANCH: Messaging mode (Ben 2026-05-31) — generate angles ──
  // Produces N problem + M desire angles for an offer and auto-saves to
  // script_angles so they appear in the Scripts > Angle picker immediately.
  if (generation_target === 'angles') {
    if (!offer_slug) return json({ error: 'offer_slug required for angle generation' }, 400)
    const n_problems       = Math.max(0, Math.min(20, body?.n_problems       ?? 5))
    const n_circumstances  = Math.max(0, Math.min(20, body?.n_circumstances  ?? 0))
    // n_outcomes preferred; n_desires accepted as legacy alias for the same.
    const n_outcomes       = Math.max(0, Math.min(20, body?.n_outcomes ?? body?.n_desires ?? 5))
    const total = n_problems + n_circumstances + n_outcomes
    if (total === 0) return json({ error: 'n_problems + n_circumstances + n_outcomes must be > 0' }, 400)
    const niche_hint = (body?.niche_hint || '').trim()

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    let offer: any
    try { offer = await loadOffer(supabase, offer_slug) }
    catch (e: any) { return json({ error: e.message }, 500) }

    const rankTier = classifyRankAwareness(offer.vertical)
    const rankMin = requiredRankExplicit(n_outcomes, rankTier)

    // ── Fire-and-forget background generation (Ben 2026-06-01) ──
    // Anything that involves Claude (or Serper) takes 30-120s. Supabase
    // closes the client connection at ~60s if no response has been sent,
    // so a synchronous wait throws "non-2xx" for any realistic batch.
    //
    // Fix: validate synchronously, schedule the real work via
    // EdgeRuntime.waitUntil(), return 202 Accepted immediately with the
    // job metadata. Angles auto-save to script_angles when done; the
    // frontend's recovery banner polls listAngles every 4s and surfaces
    // the new rows as they appear.
    const startedAt = new Date().toISOString()

    const bgJob = (async () => {
      try {
        const groundingQuery = [
          offer.vertical || '',
          offer.primary_audience || '',
          niche_hint || '',
          'owner problems frustrations forum',
        ].filter(Boolean).join(' ').slice(0, 220)
        const grounding = await fetchGrounding(groundingQuery, 6)
        const groundingBlock = formatGroundingBlock(grounding)

        // ── Anti-repetition (Ben 2026-06-01) ──
        // Ben's #1 complaint after 135 angles accumulated: "a lot of these
        // are duplicates and pretty generic — we run through these quickly,
        // get more creative." Root cause: Claude doesn't see the existing
        // library, so each run independently rediscovers the same templates
        // ("Maps top-3", "AI citation", "Just Hired Third Tech", "SEO Agency
        // Money Pit"). Fix: fetch every active angle for this offer + the
        // first ~60 chars of prospect_voice, pass them as an EXISTING list
        // with a hard "must be MEANINGFULLY DIFFERENT" rule. We cap at 80
        // most-recent to keep prompt size sane on large libraries (135+).
        let existingAnglesBlock = ''
        try {
          const { data: existing } = await supabase
            .from('script_angles')
            .select('name, angle_type, prospect_voice')
            .eq('active', true)
            .contains('offer_slugs', [offer_slug])
            .order('created_at', { ascending: false })
            .limit(80)
          if (existing && existing.length) {
            const byType: Record<string, string[]> = { problem: [], circumstance: [], outcome: [], desire: [] }
            for (const a of existing) {
              const t = (a.angle_type || 'other').toLowerCase()
              const arr = byType[t] || (byType.other = byType.other || [])
              const voice = (a.prospect_voice || '').replace(/\s+/g, ' ').trim().slice(0, 70)
              arr.push(`"${a.name}" — ${voice}`)
            }
            const lines: string[] = []
            for (const t of ['problem', 'circumstance', 'outcome', 'desire']) {
              const arr = byType[t]
              if (arr && arr.length) {
                lines.push(`  ${t.toUpperCase()} (${arr.length} already in library):`)
                arr.slice(0, 25).forEach(s => lines.push(`    - ${s}`))
                if (arr.length > 25) lines.push(`    ...(+${arr.length - 25} more — assume the obvious template variants of these are taken)`)
              }
            }
            existingAnglesBlock = `\n\nEXISTING ANGLES IN THE LIBRARY (DO NOT REPEAT — your new angles must be MEANINGFULLY DIFFERENT, not synonyms, not word-swaps, not slight reframings):\n${lines.join('\n')}\n\nIf the template families that work for this vertical are exhausted (e.g. all 7 Maps-top-3 variants are taken), do NOT return an 8th. Instead, push into UNUSED FRAMINGS: contrarian angles, weird edge-case scenarios, specific-niche identities, oddly-specific dollar/time threshold moments, identity-crisis triggers, social-pressure / status-loss angles, FOMO / regret framings, etc. We would rather see 3 fresh weird angles than 8 dupes of what's already there.`
          }
        } catch (e) {
          console.warn(`[messaging] existing-angles fetch failed: ${(e as any)?.message}`)
        }
    const rankTierBlurb = rankTier === 'HIGH'
      ? `HIGH rank-aware vertical (${offer.vertical}). At least ${rankMin} of the ${n_outcomes} OUTCOMES MUST be rank-explicit (rank_explicit=true) — literal "rank #1", "top 3 on Maps", "first pin", "AI-recommended", "the one ChatGPT names", "LSA dominance", "page-one organic". This is non-negotiable; the operator has explicitly asked to see rank-#1 angles.`
      : rankTier === 'MODERATE'
        ? `MODERATE rank-aware vertical (${offer.vertical}). At least ${rankMin} of the ${n_outcomes} OUTCOMES should be rank-explicit, but secondary to reputation / reviews.`
        : rankTier === 'LOW'
          ? `LOW rank-aware vertical (${offer.vertical}). Skip rank-explicit outcomes — referral / authority / LinkedIn desires convert better here.`
          : `Non-local vertical (${offer.vertical}). Skip Maps / AI-citation / LSA framing entirely.`

    const userMsg = [
      `OFFER: ${offer.name} (slug: ${offer.slug})`,
      `VERTICAL: ${offer.vertical}`,
      `RANK-AWARENESS TIER: ${rankTier} — ${rankTierBlurb}`,
      `PRIMARY AUDIENCE: ${offer.primary_audience || '(none defined)'}`,
      offer.mechanism_name ? `BRAND-NAMED MECHANISM (only mention in passing; the angles are upstream of mechanism): ${offer.mechanism_name}` : '',
      niche_hint ? `\nADDITIONAL CONTEXT FROM OPERATOR: ${niche_hint}\nUse this to bias the angles toward the specific niche / situation the operator named.` : '',
      groundingBlock,
      '',
      `Generate exactly ${n_problems} PROBLEMS + ${n_circumstances} CIRCUMSTANCES + ${n_outcomes} OUTCOMES (return in that order).`,
      '',
      'BUCKET DEFINITIONS:',
      '  PROBLEM      = what the prospect is stuck on. The pain. Phrased in their voice.',
      '  CIRCUMSTANCE = the situation / identity moment that makes them decision-ready. NOT a pain, NOT a desire — a STATE. e.g. "I just took on my third tech and can\'t keep them busy", "My biggest referral source just retired", "My new website went live last month and the calls didn\'t change". These are the moments when a prospect goes from "things are fine" to "I need to act".',
      '  OUTCOME      = the end-state they want. Phrased in their voice as a desire.',
      '',
      'Each angle must be specific to the audience qualifier (above). Generic "grow your business" angles will be rejected.',
      'For each angle, ALSO write why_it_matters (consequences + deeper anxiety + what they\'ve tried) and 2-3 evidence_examples (concrete situational moments, not summaries). These are not optional.',
      '',
      `RANK-EXPLICIT REQUIREMENT for OUTCOMES: at least ${rankMin} of the ${n_outcomes} outcomes MUST have rank_explicit=true. Look at the WHAT\'S CONVERTING families in the system prompt — Maps top-3, AI citation, LSA dominance, etc. — and use those literal framings. If you return fewer than ${rankMin} rank_explicit outcomes the response is INVALID. The schema flag is your forcing function: set it true for any outcome that uses rank / Maps / AI / LSA / top-N / first-pin language.`,
      '',
      'SCHWARTZ DIVERSITY (apply across the batch):',
      `- AWARENESS STAGES: distribute angles across Problem-Aware, Solution-Aware, Product-Aware, Most-Aware. A batch of ${total} should touch at least ${Math.min(total, 3)} distinct stages.`,
      '- SOPHISTICATION: tired markets need named-mechanism + sharper promise; greener pockets can land on basic claim + proof. Rotate.',
      '- MASS DESIRE: each outcome must hook into a desire the prospect ALREADY has — never invent a new one. Identify the burning emotion, then channel it.',
      '- AVOID stacking angles in the same emotional register. If two outcomes both read as "I want predictability", consolidate.',
      grounding.length
        ? 'Cite only the GROUNDING SOURCES you actually drew from for each angle. If an angle came from reasoning alone, leave its sources array empty. NEVER invent URLs or titles. Use the grounding to inform ALL THREE buckets — problems pulled from forum complaints, circumstances pulled from posts describing turning-point moments, outcomes pulled from "I wish my business looked like X" threads.'
        : 'No grounding sources were provided this run. Leave every sources array empty. NEVER invent sources.',
      `Return via the ${ANGLE_TOOL_NAME} tool with problems first, then circumstances, then outcomes.`,
      extraBlock,
    ].filter(Boolean).join('\n')

    // ── Parallel per-bucket angle generation ──
    // The previous single-call design timed out at the Edge Function's
    // 60s hard cap for any batch >~5 angles (Sonnet 4 generates ~80
    // output tok/sec; 13 angles × 500 tok = 6500 tok / 80 = 80s). Fix:
    // split into N parallel Anthropic calls, one per bucket (further
    // chunked if any single bucket > MAX_PER_CALL). Wall-clock becomes
    // max(per-call latency) ≈ 25-40s instead of sum.
    const MAX_PER_CALL = 6

    function chunkBucket(bucket: 'problem'|'circumstance'|'outcome', n: number): { bucket: 'problem'|'circumstance'|'outcome', count: number }[] {
      if (n <= 0) return []
      if (n <= MAX_PER_CALL) return [{ bucket, count: n }]
      const out: { bucket: 'problem'|'circumstance'|'outcome', count: number }[] = []
      let remaining = n
      while (remaining > 0) {
        const c = Math.min(MAX_PER_CALL, remaining)
        out.push({ bucket, count: c })
        remaining -= c
      }
      return out
    }
    const chunks = [
      ...chunkBucket('problem',      n_problems),
      ...chunkBucket('circumstance', n_circumstances),
      ...chunkBucket('outcome',      n_outcomes),
    ]

    // Bucket-specific user message — only the directives that matter for
    // this bucket. Keeps prompt size sane per call AND lets Claude focus.
    // The full ANGLE_SYSTEM_PROMPT is shared across all calls (Anthropic
    // prompt caching kicks in for free).
    function buildBucketUserMsg(bucket: 'problem'|'circumstance'|'outcome', count: number, chunkIdx: number, chunksOfThisBucket: number): string {
      const bucketBlock = bucket === 'problem'
        ? `Generate exactly ${count} PROBLEM angles. A problem = what the prospect is stuck on, the pain, phrased in their voice. e.g. "I can\'t hire a senior accountant" / "My phone stopped ringing after Google\'s LSA changes" / "Every renewal becomes a price negotiation".`
        : bucket === 'circumstance'
          ? `Generate exactly ${count} CIRCUMSTANCE angles. A circumstance = an identity/situation moment that makes the prospect decision-ready. NOT a pain. NOT a desire. A STATE. e.g. "I just took on my third tech and can\'t keep them busy" / "My biggest referral source just retired" / "My new website went live and the calls didn\'t change" / "I just crossed $1M in revenue and realized I have no marketing system". These are the inflection moments when a prospect goes from "things are fine" to "I need to act".`
          : `Generate exactly ${count} OUTCOME angles. Outcome = the end-state they want, phrased in their voice. RANK-EXPLICIT REQUIREMENT: at least ${Math.min(count, chunkIdx === 0 ? rankMin : 0)} of these MUST have rank_explicit=true${rankTier === 'HIGH' ? ' (Maps top-3, AI citation, LSA dominance, first pin, page-one organic — use those literal framings)' : ''}.${chunksOfThisBucket > 1 ? ` This is chunk ${chunkIdx + 1} of ${chunksOfThisBucket} for outcomes — make these ${count} DIFFERENT from anything else you might produce.` : ''}`
      return [
        `OFFER: ${offer.name} (slug: ${offer.slug})`,
        `VERTICAL: ${offer.vertical}`,
        `RANK-AWARENESS TIER: ${rankTier} — ${rankTierBlurb}`,
        `PRIMARY AUDIENCE: ${offer.primary_audience || '(none defined)'}`,
        offer.mechanism_name ? `BRAND-NAMED MECHANISM (only mention in passing): ${offer.mechanism_name}` : '',
        niche_hint ? `\nADDITIONAL CONTEXT FROM OPERATOR: ${niche_hint}` : '',
        groundingBlock,
        existingAnglesBlock,
        '',
        bucketBlock,
        '',
        'Each angle: specific to the audience qualifier above. why_it_matters (4-6 sentences) + 2-3 evidence_examples (concrete moments) are required, not optional.',
        '',
        `CREATIVITY MANDATE (Ben 2026-06-01): Ben is running through angles fast. He has explicitly asked for MORE CREATIVE, LESS GENERIC framings this run. The 7-template menu in the system prompt is a FLOOR, not a ceiling. Push for: (a) oddly-specific identity moments ("I'm the only ${offer.vertical || 'company'} owner in my city who still answers the phone at 9pm"), (b) contrarian / status-flip angles ("I'm tired of being the cheap option — I want to be the one they call AFTER getting three quotes"), (c) social-pressure / regret framings ("My neighbor's basement flooded and they didn't even think of me"), (d) specific-vs-generic threshold moments ("I just hired a tech who's better than me and now I need work to keep him here"), (e) FOMO on competitor wins ("My competitor just got featured in the local paper and my phone has been silent ever since"), (f) inside-baseball industry moves ("Insurance carriers are quietly rolling out their own preferred-vendor app and I'm not on it"). When in doubt, surprise the reader.`,
        '',
        grounding.length
          ? 'Cite GROUNDING SOURCES you actually used. Empty array if reasoning-only. NEVER invent URLs.'
          : 'No grounding sources this run. Return empty sources arrays.',
        `Return via the ${ANGLE_TOOL_NAME} tool.`,
        extraBlock,
      ].filter(Boolean).join('\n')
    }

    async function runOneBucketCall(bucket: 'problem'|'circumstance'|'outcome', count: number, chunkIdx: number, chunksOfThisBucket: number): Promise<any[]> {
      const userMsg = buildBucketUserMsg(bucket, count, chunkIdx, chunksOfThisBucket)
      // Distribute rank-explicit quota across all outcome chunks instead
      // of dumping it on chunk 0 (Ben 2026-06-01). Previously chunk 0 had
      // to be ALL rank-explicit and chunk 1+ was entirely free — meaning
      // half the batch lost the rank requirement. Now each chunk gets a
      // proportional share so the rank framing threads through the whole
      // batch.
      const rankMinForThisCall = bucket === 'outcome'
        ? Math.min(count, Math.ceil((rankMin * count) / Math.max(n_outcomes, 1)))
        : 0
      // Conservative payload (Ben 2026-06-01): keep Sonnet + string
      // system prompt (proven working v20). Haiku 4.5 + cache_control
      // was attempted but broke the background fetch silently — direct
      // Anthropic test confirms the payload shape is valid, so the
      // breakage is somewhere in the Deno fetch path. Revisiting after
      // proper Supabase log access. The big speed-up here is the
      // TRIMMED schema descriptions ("1-2 sentences" instead of "4-6")
      // — Claude generates ~50% less prose per angle.
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          // Generous max_tokens so Claude can complete all required
          // prose fields (why_it_matters paragraph + evidence array)
          // without truncation. Truncated tool_use responses get
          // dropped client-side and look like missing angles.
          max_tokens: Math.min(8192, 1500 + count * 500),
          system: ANGLE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMsg }],
          tools: [buildSingleBucketAngleToolSchema(bucket, count, grounding.length, rankMinForThisCall)],
          tool_choice: { type: 'tool', name: ANGLE_TOOL_NAME },
        }),
      })
      if (!upstream.ok) {
        const errText = await upstream.text()
        const msg = `Anthropic ${upstream.status} (${bucket}): ${errText.slice(0, 300)}`
        console.error(`[messaging:${bucket}] upstream fail: ${msg}`)
        throw new Error(msg)
      }
      const result = await upstream.json()
      const toolUse = (result.content || []).find((c: any) => c.type === 'tool_use')
      if (!toolUse) {
        console.error(`[messaging:${bucket}] no tool_use in response`, JSON.stringify(result).slice(0, 400))
        throw new Error(`Claude returned no tool_use for ${bucket} call`)
      }
      const u = result.usage || {}
      console.log(`[messaging:${bucket}] in=${u.input_tokens} out=${u.output_tokens}`)
      return Array.isArray(toolUse.input?.angles) ? toolUse.input.angles : []
    }

    // Fire all chunks in parallel. Partial failures don't kill the run —
    // we still save what we got + report the failure to the caller.
    const chunkResults = await Promise.allSettled(
      chunks.map((c, i) => {
        const sameTypeChunks = chunks.filter(x => x.bucket === c.bucket).length
        const sameTypeIdx = chunks.slice(0, i).filter(x => x.bucket === c.bucket).length
        return runOneBucketCall(c.bucket, c.count, sameTypeIdx, sameTypeChunks)
      })
    )
    const generated_angles: any[] = []
    const chunk_errors: string[] = []
    chunkResults.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        for (const a of r.value) generated_angles.push(a)
      } else {
        chunk_errors.push(`${chunks[i].bucket}×${chunks[i].count}: ${r.reason?.message || r.reason}`)
      }
    })
    if (generated_angles.length === 0) {
      return json({ error: 'all bucket calls failed', detail: chunk_errors }, 502)
    }

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
    // Normalize legacy 'desire' → 'outcome' on save so the DB stays
    // consistent with the new bucket naming (migration 121). 'desire' is
    // still accepted by the CHECK constraint for backwards compat.
    const normalizeType = (t: string) => t === 'desire' ? 'outcome' : t
    for (const a of generated_angles) {
      const at = normalizeType((a.angle_type || '').toString())
      const slug = `${offer.slug}-${at}-${slugify(a.name)}`
      if (!slug || seenSlugs.has(slug)) continue
      seenSlugs.add(slug)
      const resolved = resolveSources(a.sources)
      a.sources = resolved
      a.angle_type = at   // mutate the response too so UI sees 'outcome' not 'desire'
      inserts.push({
        slug,
        name: a.name,
        angle_type: at,
        prospect_voice: a.prospect_voice,
        hook_build_sketch: a.hook_build_sketch,
        pain_points: Array.isArray(a.pain_points) ? a.pain_points : [],
        why_it_matters: typeof a.why_it_matters === 'string' ? a.why_it_matters : null,
        evidence_examples: Array.isArray(a.evidence_examples) ? a.evidence_examples : [],
        sources: resolved,
        offer_slugs: [offer.slug],
        qualifier: offer.primary_audience || '',
        primary_promise: '',
        mechanism_short: '',
        guarantee_close: '',
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
        // Log final outcome for ops visibility (Supabase function logs).
        console.log(`[messaging] done offer=${offer.slug} buckets=${n_problems}/${n_circumstances}/${n_outcomes} generated=${generated_angles.length} saved=${saved.length} save_error=${save_error || '-'} chunk_errors=${chunk_errors.length}`)
      } catch (e: any) {
        console.error(`[messaging] background job failed offer=${offer.slug}: ${e?.message || e}`)
      }
    })()

    // Schedule the background work and return immediately. The
    // EdgeRuntime global is provided by Supabase's edge runtime; the
    // typeof guard keeps this safe under `deno run` for local tests.
    // @ts-ignore — EdgeRuntime is a Supabase runtime global
    if (typeof EdgeRuntime !== 'undefined' && (EdgeRuntime as any).waitUntil) {
      // @ts-ignore
      ;(EdgeRuntime as any).waitUntil(bgJob)
    } else {
      // Fallback: kick off but don't await. Locally this means the
      // job runs to completion in the same process before the response
      // is flushed; on Supabase the waitUntil branch handles it.
      bgJob.catch((e: any) => console.error('[messaging] bg fallback fail', e?.message || e))
    }

    return json({
      ok: true,
      mode: 'messaging',
      target: 'angles',
      queued: true,
      started_at: startedAt,
      expected_count: total,
      offer: { slug: offer.slug, name: offer.name, vertical: offer.vertical },
      buckets: { n_problems, n_circumstances, n_outcomes },
      rank_tier: rankTier,
      rank_explicit_min: rankMin,
      grounding: { enabled: !!Deno.env.get('SERPER_API_KEY') },
      model: ANTHROPIC_MODEL,
      note: 'Generation runs in the background. Poll script_angles for new rows tagged with the offer slug; expect them within 60-120s depending on batch size.',
    }, 202)
  }

  // ── BRANCH: auto-generate proof characters for an angle ──
  // Ben 2026-05-31: when the operator hits Generate on an angle with no
  // saved proofs, the frontend fires this branch first to populate the
  // library so the main script generation has named clients to rotate
  // through. Produces N rows in script_proof_characters keyed on the
  // angle, with name + result_short + (optional) result_long.
  if (generation_target === 'proofs') {
    if (!angle_slug) return json({ error: 'angle_slug required for proof generation' }, 400)
    const n = Math.max(1, Math.min(10, body?.n ?? 4))
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    let angle: any
    try { angle = await loadAngle(supabase, angle_slug) }
    catch (e: any) { return json({ error: e.message }, 500) }
    const offerSlugForAngle = angle.offer_slugs?.[0] || null
    let offer: any = null
    if (offerSlugForAngle) {
      try { offer = await loadOffer(supabase, offerSlugForAngle) } catch {}
    }

    const PROOF_TOOL_NAME = 'generate_proof_characters'
    const PROOF_TYPE_ENUM = [
      'case_study', 'testimonial', 'statistic', 'authority',
      'demonstration', 'social_volume', 'comparison',
    ]
    const tool = {
      name: PROOF_TOOL_NAME,
      description: `Return exactly ${n} proof items for this angle, MIXED across Schwartz proof types (not all case_study). Each item is a tight one-line proof a script can hook into.`,
      input_schema: {
        type: 'object',
        properties: {
          proof_characters: {
            type: 'array',
            minItems: n,
            maxItems: n,
            items: {
              type: 'object',
              properties: {
                proof_type: { type: 'string', enum: PROOF_TYPE_ENUM, description: 'Which Schwartz proof kind this item represents. Across the batch, rotate so the operator gets a mix.' },
                name: { type: 'string', description: 'Source identifier — for case_study/testimonial it\'s a first name ("Eric"); for statistic it\'s the metric label ("HomeAdvisor burnout rate"); for authority it\'s the citation source ("Roto-Rooter franchise manual"); for demonstration it\'s the demo name ("Month 1 vs month 6"); for social_volume it\'s the cohort label ("Restoration cohort 2024"); for comparison it\'s "vs <alternative>".' },
                result_short: { type: 'string', description: 'ONE LINE proof, hook-ready. case_study: "Closed a $215K job in 90 days". testimonial: full quote with attribution. statistic: numeric data point. authority: borrowed-credibility one-liner. demonstration: before→after numbers. social_volume: aggregate count. comparison: vs-alternative metric. Max 140 chars.' },
                result_long: { type: 'string', description: 'Optional 2-3 sentence narrative for body-roster use. Leave empty if unsure — operator will fill in.' },
                industry_context: { type: 'string', description: 'One-word industry tag like "restoration", "accounting", "plumbing". Match the angle\'s vertical.' },
                metric_kind: { type: 'string', description: 'Category tag like "revenue_close", "calls_increase", "ranking", "speed_close", "lead_volume", "market_data", "process_quote".' },
              },
              required: ['proof_type', 'name', 'result_short', 'industry_context', 'metric_kind'],
            },
          },
        },
        required: ['proof_characters'],
      },
    }

    // Build a per-type allocation directive. For n=4 we want roughly:
    //   2 case_study (the workhorse), 1 statistic, 1 testimonial OR authority.
    // For larger n we widen to 5-6 types.
    const mixHint = n <= 3
      ? '1 case_study + 1 statistic + 1 testimonial'
      : n <= 5
        ? '2 case_study + 1 statistic + 1 testimonial + 1 authority'
        : `${Math.ceil(n/3)} case_study + ${Math.ceil(n/4)} statistic + ${Math.ceil(n/4)} testimonial + 1 authority + 1 comparison (rest filled with demonstration or social_volume)`

    const userMsg = [
      `ANGLE: ${angle.name}`,
      `ANGLE TYPE: ${angle.angle_type}`,
      `PROSPECT VOICE: "${angle.prospect_voice || ''}"`,
      `QUALIFIER: ${angle.qualifier || ''}`,
      offer ? `OFFER: ${offer.name} (vertical: ${offer.vertical})` : '',
      offer?.default_proof_characters?.length ? `EXISTING NAMES ON OFFER (avoid duplicates): ${offer.default_proof_characters.join(', ')}` : '',
      '',
      `Generate exactly ${n} proof items tailored to THIS angle. CRITICAL: ROTATE PROOF TYPES — do NOT return ${n} case_study items.`,
      `Target mix for this batch: ${mixHint}.`,
      '',
      'Per-type rules:',
      '  - case_study: First-name only. Result has specific $ + timeframe. ("Eric — closed a $215K loss-of-business job in 90 days")',
      '  - testimonial: Quote in double quotes + attribution. ("My closing rate doubled in week 2." — Mark, NC plumber)',
      '  - statistic: Market-level data point about the audience. ("67% of restoration owners burn out on HomeAdvisor in year 2")',
      '  - authority: Borrowed credibility from a named industry source. ("Roto-Rooter franchise manual explicitly recommends abandoning shared-lead platforms")',
      '  - demonstration: Show-not-tell, dashboard-style. ("$14K → $48K MRR by month 6, charted")',
      '  - social_volume: Aggregate cohort proof. ("Across 38 restoration companies in 2024, avg $32K/mo lift")',
      '  - comparison: vs the alternative. ("vs HomeAdvisor: 3.2x bookings, 1/4 the cost-per-lead")',
      '',
      '  - Match the angle\'s lived reality — accounting angles get CPA-flavored proofs, restoration angles get restoration-flavored proofs.',
      '  - Numbers should be plausible-but-clearly-fabricated so the operator edits them in. Use round numbers ($50K, 90 days, 3x) rather than suspiciously precise ones.',
      `Return via ${PROOF_TOOL_NAME}.`,
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
        max_tokens: 1200 + n * 350,
        system: 'You generate realistic-sounding proof characters for direct-response ad scripts at OPT Digital. The names + results must be specific enough that a script can hook into them, but generic enough that they don\'t accidentally claim a real result for a real OPT client. The operator will edit anything that needs precision.',
        messages: [{ role: 'user', content: userMsg }],
        tools: [tool],
        tool_choice: { type: 'tool', name: PROOF_TOOL_NAME },
      }),
    })
    if (!upstream.ok) {
      const errText = await upstream.text()
      return json({ error: `Anthropic ${upstream.status}: ${errText.slice(0, 400)}` }, 502)
    }
    const result = await upstream.json()
    const toolUse = (result.content || []).find((c: any) => c.type === 'tool_use')
    if (!toolUse) return json({ error: 'Claude did not return proof tool_use', raw: result }, 502)
    const generated: any[] = toolUse.input?.proof_characters || []

    // Upsert into script_proof_characters keyed on (angle_slug, name).
    // Dedup within the batch so we don't hit a unique-constraint collision.
    const seen = new Set<string>()
    const inserts: any[] = []
    let order = 100
    const ALLOWED_TYPES = new Set([
      'case_study', 'testimonial', 'statistic', 'authority',
      'demonstration', 'social_volume', 'comparison',
    ])
    for (const p of generated) {
      const name = (p.name || '').trim()
      if (!name || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      const proof_type = ALLOWED_TYPES.has(p.proof_type) ? p.proof_type : 'case_study'
      inserts.push({
        angle_slug,
        name,
        result_short: (p.result_short || '').trim().slice(0, 240),
        result_long: (p.result_long || '').trim() || null,
        industry_context: (p.industry_context || '').trim() || null,
        metric_kind: (p.metric_kind || '').trim() || null,
        proof_type,
        display_order: order,
        active: true,
      })
      order += 10
    }

    let saved: any[] = []
    let save_error: string | undefined
    try {
      const { data, error } = await supabase
        .from('script_proof_characters')
        .upsert(inserts, { onConflict: 'angle_slug,name' })
        .select()
      if (error) save_error = error.message
      else saved = data || []
    } catch (e: any) {
      save_error = e.message
    }

    return json({
      ok: true,
      mode: 'proofs',
      angle: { slug: angle.slug, name: angle.name },
      proof_characters: generated,
      saved,
      save_error,
      model: ANTHROPIC_MODEL,
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

    let angle: any, mechanism: any = null, proofs: any[], shapes: any[], skeletons: any[], scriptExamples: any[]
    try {
      const needsShapes = script_type === 'hook' || script_type === 'joined'
      const needsSkeletons = script_type === 'body' || script_type === 'joined'
      ;[angle, mechanism, proofs, shapes, skeletons, scriptExamples] = await Promise.all([
        loadAngle(supabase, angle_slug),
        mechanism_slug ? loadMechanism(supabase, mechanism_slug) : Promise.resolve(null),
        loadProofCharacters(supabase, angle_slug),
        needsShapes ? loadHookShapes(supabase, target_shapes.length ? target_shapes : undefined) : Promise.resolve([]),
        needsSkeletons ? loadBodySkeletons(supabase, target_length) : Promise.resolve([]),
        // script_mode-matched example fetch (migration 143). Best-effort —
        // returns [] on any error so generation never blocks on this.
        loadScriptExamples(supabase, script_mode, script_type, null /* angle.offer_slugs picked up below */),
      ])
    } catch (e: any) {
      return json({ error: e.message }, 500)
    }
    // Re-narrow the examples to this offer if we have one — we passed null
    // to the loader above so it'd return both global + offer-specific rows;
    // resort with the actual offer_slug we now have from the angle.
    try {
      const offerSlugForExamples = angle?.offer_slugs?.[0] || null
      if (offerSlugForExamples && scriptExamples.length) {
        scriptExamples = [...scriptExamples].sort((a, b) => {
          const am = a.offer_slug === offerSlugForExamples ? 0 : (a.offer_slug ? 2 : 1)
          const bm = b.offer_slug === offerSlugForExamples ? 0 : (b.offer_slug ? 2 : 1)
          return am - bm
        }).slice(0, 3)
      }
    } catch { /* defensive — never block on example sorting */ }
    // Merge in per-OFFER proofs (migration 120) — these apply across
    // every script for the offer, on top of the angle-specific proofs.
    // Dedup by lowercased name to avoid the same proof appearing twice
    // if the operator named it identically in both scopes.
    try {
      const offerSlugForAngle = angle?.offer_slugs?.[0]
      if (offerSlugForAngle) {
        const offerForProofs = await loadOffer(supabase, offerSlugForAngle).catch(() => null)
        const offerProofs = Array.isArray(offerForProofs?.offer_proof_items)
          ? offerForProofs.offer_proof_items.map((p: any) => ({
              name: (p?.name || '').toString(),
              result_short: (p?.result_short || '').toString(),
              result_long: p?.result_long || null,
              industry_context: p?.industry_context || null,
              metric_kind: p?.metric_kind || null,
              proof_type: p?.proof_type || 'case_study',
              _origin: 'offer',
            })).filter((p: any) => p.name && p.result_short)
          : []
        if (offerProofs.length) {
          const seenNames = new Set(proofs.map((p: any) => (p?.name || '').toLowerCase()))
          for (const op of offerProofs) {
            if (seenNames.has(op.name.toLowerCase())) continue
            proofs.push(op)
            seenNames.add(op.name.toLowerCase())
          }
        }
      }
    } catch (e) {
      console.warn(`[offer_proof_items] merge failed: ${(e as any)?.message}`)
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

    // Mode-aware shape filtering (Ben 2026-06-01). Educational mode REQUIRES
    // curiosity/reframe/trend openers (E/F/H) — never direct offer (A) or pain
    // anchor (C). Hybrid excludes A so it leans question-first. Direct uses
    // all shapes. This prevents single-concept hook generation from defaulting
    // to Shape A and then contradicting the mode directive.
    // Ben 2026-06-01 (afternoon): "make the educational ones a lot more
    // direct" — loosened the Educational allowlist to include Direct
    // (A) and Reality (D) shapes too. The mode is now PRIMARILY about
    // the script POSTURE (mechanism-led teaching, soft offer) not about
    // forcing curiosity-shape openers exclusively. Hybrid keeps its
    // broader allowlist. Direct still uses all shapes.
    // Ben 2026-06-01 PM: dropping Shape B (Hypothetical Question — "Quick
    // question... if we told you... would you take us up on that?") from
    // Educational. The shape's natural cadence is a single run-on sentence
    // 25-30 words long, which violates the 5th-grade reading level rule.
    // Direct and Hybrid keep it because they tolerate slightly longer
    // sentences, but the model is told elsewhere to break it into two.
    const MODE_SHAPE_ALLOWLIST: Record<string, string[]> = {
      educational: ['A', 'D', 'E', 'F', 'H'],
      hybrid:      ['A', 'D', 'E', 'F', 'G', 'H'],
      direct:      [],   // empty = use all
      rom:         [],   // ROM uses all 8 shapes — diversity is the whole point
    }
    const modeAllowed = MODE_SHAPE_ALLOWLIST[script_mode] || []
    const shapesForMode = modeAllowed.length
      ? shapes.filter((s: any) => modeAllowed.includes(s.code))
      : shapes
    const effectiveShapes = shapesForMode.length ? shapesForMode : shapes  // safety fallback

    const shapeRotation = (script_type === 'hook' || script_type === 'joined')
      ? planShapeRotation(effectiveShapes, n_concepts) : []

    const angleCtx = buildAngleContext(angle, proofs, mechanism, use_mechanism)
    const shapesBlock = (script_type === 'hook' || script_type === 'joined')
      ? `\n\nHOOK SHAPES AVAILABLE:\n${buildHookShapesBlock(effectiveShapes)}` : ''
    const skeletonsBlock = (script_type === 'body' || script_type === 'joined')
      ? `\n\nBODY SKELETON:\n${buildBodySkeletonsBlock(skeletons)}` : ''
    const rotationBlock = shapeRotation.length
      ? `\n\nSHAPE ROTATION PLAN (the ${n_concepts} ${script_type === 'joined' ? 'joined scripts' : 'hooks'} you return MUST use these shape codes in this order, one per concept):\n${shapeRotation.map((c, i) => `  ${i + 1}. Shape ${c}`).join('\n')}\nProof character rotation: cycle through the proof characters listed above so we don't get 5 Metros in a row.`
      : ''

    const hasProofs = proofs.length > 0
    const proofNames = proofs.map((p: any) => p?.name).filter(Boolean)

    const sharedVarianceBlock = n_concepts > 1
      ? `\n\nCONCEPT-VARIANCE DIRECTIVE (n_concepts=${n_concepts}). Ben's #1 feedback on the last batch: "they're all kind of the same." Each of the ${n_concepts} concepts MUST feel like a distinctly different argument. Vary, concept-by-concept, on ALL FOUR axes:

  (a) OPENING MOVE — the actual first sentence shape must differ. If concept 1 opens with a qualifier-call-out ("Restoration owners doing $50k+/mo:"), concept 2 should open with a market-truth statement, concept 3 with a contrast question, concept 4 with a reframe, etc. Forbidden: ${n_concepts >= 3 ? 'starting more than 2 concepts with the same opening shape' : 'starting both concepts with the same opening shape'}. Across the batch, hit at least ${Math.min(n_concepts, 4)} distinct opening shapes.

  (b) PROOF CHARACTER DRIVER — each concept anchors on a DIFFERENT named proof (cycle through ${proofNames.length ? proofNames.join(' / ') : 'the proofs available; if none are defined, use different cohort framings such as "the operators we run this for in Phoenix" or "the 23-operator 2025 cohort" or "every owner who has been through the signal rebuild"'}). Never re-use the same lead proof across two concepts.

  (c) TEACH FOCUS — what specific aspect each concept educates on. Concept 1 might teach WHY response time matters (3.2x weight vs bid); concept 2 might teach WHAT the proximity signal actually measures; concept 3 might teach HOW review velocity gets engineered. Don't teach the same lesson twice — pick a different facet of the mechanism each concept.

  (d) PATTERN STATEMENT / REFRAME — each concept's underlying truth-claim about the prospect's world must be different. If concept 1 reframes "bid = ranking", concept 2 must reframe a DIFFERENT misconception (e.g. "more reviews ≠ better ranking — recency matters more than count").

A reviewer reading all ${n_concepts} back-to-back should NOT be able to say "these are three versions of the same script." They should say "these are ${n_concepts} different arguments for the same offer, each with its own opening, its own proof, its own teach, and its own reframe." If you find yourself writing nearly-identical openings or recycling the same proof character, STOP and pick a different axis to vary on.`
      : ''

    const sharedNumberRules = `\n\nNUMBER RULES (apply to every concept):
- Specific + uneven beats round + clean. "47 leads in 11 days" beats "50 leads in 14 days." "$32K MRR" beats "$30K MRR." "3.2x" beats "3x." Round numbers signal copywriter, not operator.
- Pull numbers ONLY from the proof character results above. Do NOT invent new numbers. If a proof says "$215K loss-of-business job in 90 days," use those exact figures.
${hasProofs
  ? `- Proof characters EXIST for this angle (${proofNames.join(', ')}). You MUST name them by first name as written. Banned phrasing: "one client," "another client," "a third client," "we had a client," "I worked with someone" — every proof reference must be a NAMED first name from the roster.`
  : `- NO proof characters exist for this angle. DO NOT invent named clients. DO NOT write "one client / another client / a third client" or any fake-specific person. Instead, write the proof block in COHORT VOICE: "the restoration companies we run this for", "every operator we've put through the LSA-foundation rebuild", "the owners in our portfolio". This signals truth without fabricating a person. The operator will swap in real names later.`}

CTA RULES (CRITICAL — apply to body + joined; hooks have their own ending):
- The phrase "So if that sounds [adjective], click the link below to book a call where we can talk and tell you more" — and any close variant of it — appears EXACTLY ONCE per script, at the FINAL line. Not after the hook. Not in the middle. ONLY as the closing line.
- For joined scripts specifically: NEVER place a CTA between the hook and the body. The body must continue from the hook with a state-of-play / specific-scene opener (Beat 1), then build to ONE CTA at the very end.
- Banned mid-script CTA patterns: "click the link below" / "book a call" / "tap the button" / "DM us" — these only appear in the final 1-2 sentences of the script.`

    const typeSpecificInstructions =
      script_type === 'hook'
        ? `Each hook is a SINGLE PARAGRAPH. Length: 40-65 words HARD CAP at 65 (Ben 2026-06-01 PM: hooks were too long; Hormozi-style hooks punch). Friend-talk voice. Short sentences. Identity + pain or curiosity or false-belief — pick one of the $100M hook formulas from rule 11(e). NO CTA tee-up in the hook. The hook is standalone — an editor pairs it with a body later.`
        : script_type === 'body'
          ? `Each body follows the 9-entry skeleton above (7 logical beats; beat 5 is split 5a/5b/5c) but EVERY BEAT MUST READ LIKE A FRIEND TALKING — short sentences, simple words, conversational rhythm. CRITICAL — Beat 1 is the STATE-OF-PLAY / SCENE OPENER, not a CTA. The CTA appears ONLY in Beat 7 (Final CTA). NEVER open the body with "So if that sounds [adjective], click the link." Beat 1 grounds the reader in a concrete moment from the angle. Beat 2 (pattern statement) says the underlying truth in plain words — no academic dropouts, no "dependency" / "engineered" / "topical authority" / "ranking factor" jargon. Beats 3 (proof — ONE named character with a real story, NOT a roster of names), 4 (mechanism reveal — friendly name + plain explanation of WHAT it actually does), 5a/5b/5c (3-step HOW — each step a short sentence about what gets fixed), 6 (guarantee in plain words), 7 (final CTA — "click the link below" lives ONLY here). Length: 200-300 words HARD CAP at 300 (Ben 2026-06-01 PM: previous bodies were too long and lost the conversational rhythm). If you find yourself over 300, cut filler — the rhythm gets BETTER when the script gets shorter.`
          : `Each joined script is HOOK + BODY chained. Write the hook FIRST using the rotation's assigned shape (40-65 words, friend-talk voice), then write a body that explicitly continues from THAT hook's posture (don't switch proof characters between hook and body). Body follows the skeleton above — Beat 1 is the state-of-play opener, NOT a CTA. CTA appears ONLY in Beat 7. Return as separate strings (hook_text + body_text) and as the combined body field. Length: 250-360 words total HARD CAP at 360.`

    // Script mode directive (Ben 2026-06-01, rewritten Schwartz-first after
    // he flagged that examples were being copied verbatim and that
    // Educational still felt too templated).
    //
    // Mode = Schwartz Stage. Direct = Stage 1-2 (claim-led, market hasn't
    // seen this promise yet). Hybrid = Stage 2-3 (claim + emerging
    // mechanism). Educational = Stage 3-4 (saturated market — mechanism-led
    // headlines, claim follows the mechanism). The restoration / roofing /
    // plumbing markets are heavily Stage 3-4 in 2026, so Educational is
    // where most of the conversion lift lives there.
    //
    // CRITICAL: this block describes SHAPE + RULES only. NO verbatim
    // example sentences. Claude was copying my "How is it possible..."
    // example word-for-word and the output read like the example. The
    // shape descriptions below let Claude generate fresh openers in the
    // angle's voice. (Schwartz, p.vii: "This book is about avoiding the
    // need for copying or imitating any other product or advertisement.")
    //
    // NOTE: `offer` is NOT in scope in the template branch (only angle,
    // proofs, mechanism, shapes, skeletons). DO NOT reach for offer.* here.
    const scriptModeBlock = (() => {
      if (script_mode === 'rom') {
        // ROM mode (Ben 2026-06-09) — validated across 40 scripts
        // (20 electrician + 20 restoration). Locked body skeleton with
        // a diverse hook on every concept. The "#1 in 90 days or money
        // back" line is the OFFER at the close — NEVER the hook.
        // Ben killed a previous batch where every hook was that line.
        return script_type === 'hook'
          ? `\n\nSCRIPT MODE: ROM (diverse-hook, offer-at-close).
Open with one of these shapes — vary across the batch, no repeats:
- Insight reveal: "Most ${'{vertical}'} don't know this yet. Google's AI now ranks Maps by..."
- AI shift / trend: "Google's AI rewrote how it ranks ${'{vertical}'} on Maps in 2025..."
- Mechanism reveal: "Three signals on your Google Business Profile decide who ranks #1..."
- Pattern interrupt: "Your website isn't what ranks you anymore..."
- Story-led: "[Proof name] was getting zero direct calls from Google. Not low. Zero..."
- Mistake framing: "The reason most $50K+/month ${'{vertical}'} are stuck isn't bad work. It's the wrong product..."
- Identity / full pipeline: "The #1 ${'{vertical}'} in your city wakes up to a full pipeline every morning..."
- Direct qualifier-led: "${'{vertical}'} doing $50K+/month. This is for you."
- Trend / future: "The ${'{vertical}'} dominating Google Maps in 2026 won't be the ones with the biggest ad budgets..."
- Outcome-led: "5 new customers a week. From Google. Without spending a dollar on ads."
- Fire-your-agency variants: "You're allowed to fire your SEO agency..." / "Your SEO agency has had 12 months..." / "We don't sell SEO. We install signals."

Length: 40-65 words. Friend-talk voice. Identity / vertical callout in the hook itself.

BANNED in ROM hooks:
- Questions at the start ("Have you ever wondered...")
- The "#1 in 90 days or money back" line — that's the OFFER, it goes in the body close
- Competitor framing ("your competitors", naming franchises)
- Filler ("quietly", "something most don't know")
- "Get Found engine" / "Maps Mastery" branded names
- Problem-aware stats ("78% of emergency calls go to Google first")
- "shops" — use "company / companies"

VARIETY CHECK: across the batch, every hook MUST use a different shape. Repeating a shape across two concepts is a fail.`
          : `\n\nSCRIPT MODE: ROM (locked body skeleton — only the hook varies).
The body is FIXED across every script in a batch. Only the hook varies. The body is:

1. SETUP — one short paragraph. "$50K+/month [vertical]" qualifier + ONE named real proof character + their concrete result number. Example: "If you do $50K+/month and you're not in the top 3 for '[vertical] near me,' you're missing at least one. Hamish from HM Electrical went from zero direct calls to 90+ in 100 days after we installed his."

2. REVEAL — verbatim line, swap vertical only:
   "Here's the truth Google won't say out loud. Their AI doesn't rank you by your website anymore. It ranks you by proof — proof you serve the area, proof people pick you, proof you're still open. Most [vertical] profiles miss all three."

3. OFFER — verbatim:
   "We'll make you the #1 company in your area in 90 days or your money back. No ads. No retainer."

4. CTA — variant action that ties back to the hook's angle:
   "If you're a $50K+/month [vertical] ready to [be #1 / fire the retainer and rank / stop renting your ranking / etc.], click below."

Length: 180-230 words total (hook + body combined). Short. Tight. No filler.

BANNED in ROM bodies:
- Complex math (e.g. "$3K × 18 months = $54K") — say "tens of thousands"
- Inventing proof character names — use ONLY the real ones from the angle's proof roster
- Restating the reveal in different words — copy it verbatim
- Mid-body CTA — CTA is the final line only
- Branded mechanism names — say "three specific signals on your Google Business Profile"`
      }
      if (script_mode === 'direct') {
        return script_type === 'hook'
          ? `\n\nSCRIPT MODE: DIRECT (Schwartz Stage 1-2 — claim-led, FRIEND-TALK).
Talk to a restoration owner like you actually know one. Identity (revenue band + situation) + a punchy promise with a real number + a money-back. Use one of the Hormozi $100M formulas from system rule 11(e). Length: 40-65 words. Short sentences. Simple words. No jargon.

REGISTER CHECK: would your hook sound natural said out loud at a job site? If it sounds like a LinkedIn post or a TED talk intro, rewrite shorter and plainer. Avoid stacking ALL benefits — pick the sharpest one and lead with it. The hook should make a busy operator stop scrolling for 3 seconds, not read like a brochure.`
          : `\n\nSCRIPT MODE: DIRECT (Schwartz Stage 1-2 — claim-led, FRIEND-TALK BODY).
Open with a scene the operator lives — a specific search they're losing, a competitor's truck in their neighborhood, a number on their dashboard. Short. Concrete. Then drive: claim → ONE named proof with a real story → mechanism (friendly name, plain what-it-does) → 3 short steps → guarantee in plain words → CTA. Length: 200-300 words.

VOICE CHECK every paragraph: does this sound like a friend explaining how to fix the operator's problem at a bar? Or does it sound like an ad agency? If it's an agency, rewrite shorter + plainer. Banned phrases: "leverage", "engineered", "dependency", "topical authority", "service radius weighting" — say what these actually mean in plain words. The body is a 60-second conversation that ends with "tap below."`
      }
      if (script_mode === 'hybrid') {
        return script_type === 'hook'
          ? `\n\nSCRIPT MODE: HYBRID (Schwartz Stage 2-3 — claim + reveal, FRIEND-TALK).
One sentence that flips what the operator thinks they know — said in plain words, not jargon. Then the claim doubles down on that flip. Then the money-back. Length: 40-65 words.

Plain-words example of the flip (do NOT copy, write fresh in the angle's voice): "Most restoration guys think Google ranks them by who bids highest. They don't. They rank by who answers the phone fastest." — short, friend-talk, surprising. Then the claim leans on that surprise.

If the flip is jargon ("response-time signal weighting") → rewrite it the way you'd say it at a bar.`
          : `\n\nSCRIPT MODE: HYBRID (Schwartz Stage 2-3 — claim + reveal, FRIEND-TALK BODY).
Direct body shape with ONE plain-words mechanism flip woven into Beat 2 — said the way a friend would tell you. The reveal is 1-2 sentences MAX. After that, return to direct flow: ONE named proof story → mechanism (friendly name + plain explanation) → 3 short steps → guarantee → CTA. Length: 200-300 words.

VOICE CHECK: the flip sentence must be the kind of insight that makes the operator think "huh, I didn't know that." NOT "I've heard that in every ad." If it sounds like every other restoration ad — rewrite the flip with a sharper, more specific angle the prospect hasn't been told before.`
      }
      // educational — Schwartz Stage 3-4: MECHANISM-LED headline.
      // Stage 3 = "your market has heard all the claims; what they need
      // now is A NEW MECHANISM — a new way to make the old promise work."
      // Stage 4 = the mechanism itself becomes overworked, so you have
      // to find a SHARPER version of the mechanism or a contrarian angle.
      return script_type === 'hook'
        ? `\n\nSCRIPT MODE: EDUCATIONAL (Schwartz Stage 3-4 — mechanism-led, FRIEND-TALK).

The market has heard every claim. They need a fresh angle on HOW it actually works to believe you. Educational hooks lead with that fresh angle in PLAIN WORDS — then close with the offer + money-back.

═══ STRUCTURE ═══

[1] OPEN with one of these moves (pick whichever fits the angle; write the wording fresh in the prospect's voice, do NOT copy):
   - The contrast question (Hormozi's curiosity formula): "Why do some restoration guys book 10 Google calls a week while others spend the same and get 2?"
   - The flip / reframe in plain words: "It's not about your bid. It's about how fast you pick up the phone."
   - The trend-on-the-ground: "The guys winning Maps in 2026 aren't the biggest bidders. They figured out something different."
   - The "just talked to..." opener: "Just got off the phone with a guy in Charlotte. He told me how he moved from spot 5 to spot 1 in 47 days. It blew my mind."
   - The identity + revealed pain: "If you're a restoration owner spending $2k+/mo on LSA and still buried, you're fighting the wrong battle."

[2] DROP THE INSIGHT in plain words. Name the actual thing — response time, fresh reviews, how big an area Google shows you in — but say it the way a friend would say it. NOT "review velocity signals" → say "how fast new reviews come in." NOT "service radius weighting" → say "how big an area Google trusts you to serve." NOT "topical authority" → say "Google sees you as the expert on water damage."

[3] CLOSE with a soft offer + money-back: "We do this for restoration guys. Top 3 in 90 days or your money back." Short. Direct. Plain.

═══ HARD RULES ═══

Length: 50-75 words HARD CAP at 75 (Ben 2026-06-01 PM: prior version was too long-winded).

VOICE — this is the biggest rule: write like you're explaining the insight to a friend who runs a restoration company. Contractions everywhere. Short sentences. Fragments OK. Direct address. NO "engineered" / "dependency" / "algorithm" / "optimize" / any LinkedIn-bro language. If your draft hook sounds like a podcast intro to a marketing show, you've nailed it. If it sounds like a SaaS landing page, rewrite.

VARIETY ACROSS A BATCH: across N hooks, mix the opening moves above. A batch of 5 should hit at least 3 different moves. Banned: starting more than 2 hooks with "Restoration owners doing $50k+/mo:" — that's a tic, vary the open.`
        : `\n\nSCRIPT MODE: EDUCATIONAL (Schwartz Stage 3-4 — mechanism-led body, FRIEND-TALK BODY).

You're explaining to a friend who runs a restoration company how the game actually works — and you happen to do this for a living. The body teaches AND sells, both in friend-talk. No academic dropouts. No jargon. Short sentences. Concrete scenes.

You don't have to follow the 9-entry skeleton beat-for-beat. The CONVERSATION drives the order — reorder or merge where the friend-talk flows better.

═══ WHAT MUST HAPPEN (in plain words, conversational order) ═══

1. SCENE OPENER — paint the moment in 2-4 short sentences. Their dashboard read. A search they ran. A competitor's truck. Concrete + specific.
2. THE INSIGHT in plain words — the angle's mechanism reframe, but said the way you'd say it at a bar. NOT "Google's algorithm weighs response time 3.2x more than bid amount." YES "Google cares more about how fast you pick up than how much you bid. Most guys don't know this."
3. ONE NAMED PROOF — short story (4-6 sentences max). One person, real numbers, real outcome. NOT a roster. Show how the insight played out for them.
4. THE MECHANISM in plain words — name your system with a friendly name + explain what it actually does in 2-3 sentences. NOT "the LSA Signal Engineering System tunes proximity weighting." YES "We call it the Pin-1 Rebuild. It's three things we fix on your Google profile so the calls come to you instead of ServPro."
5. THE 3 STEPS — each in 1-2 short sentences. What gets fixed. Plain words.
6. GUARANTEE in plain words — "Top 3 in 90 days or your money back." Not "we guarantee positioning above the fold." Just say what they get and what happens if they don't.
7. CTA — "Tap below. Let's talk." Or "Click the link and we'll walk through your numbers." Short.

═══ VOICE — THIS IS THE BIGGEST RULE ═══

Read every paragraph out loud in your head. If it sounds like an ad, a LinkedIn post, or a SaaS sales page — rewrite shorter and plainer. If it sounds like a person talking to a person — keep it.

BANNED vocabulary (rewrite in plain words): dependency, engineered, optimize, algorithm (say "what Google looks at"), topical authority, ranking factor, service radius weighting, proximity algorithm, review velocity, preferred-vendor API, systematic application, methodology, infrastructure, framework, pipeline (in business sense).

BANNED rhythm: any sentence longer than 25 words unless it earns it with rhythm. Long. Short. Short. Long. Vary deliberately. Hormozi style.

Length: 200-300 words HARD CAP at 300 (Ben 2026-06-01 PM: shorter wins). If you're at 280 and the script feels good, ship it. If you're at 290 looking for filler — STOP, the script is done.

ANTI-TEMPLATE CHECK: if your body could be swapped to roofing or plumbing with 3-word find-replace, it's too generic — anchor on this angle's specific scene, specific named proof, specific in-the-trenches detail.`
    })()

    // Winning-ad reference examples (migration 143). Placed AFTER the
    // mode-specific block so the model has internalised the mode rules
    // before seeing what good copy looks like — the examples then
    // ground the abstract rules in concrete style. Empty string when
    // there are no examples for this mode/script_type.
    const examplesBlock = formatScriptExamplesBlock(scriptExamples, script_mode)

    const userMsg = [
      angleCtx,
      shapesBlock,
      skeletonsBlock,
      rotationBlock,
      `\n\nGenerate exactly ${n_concepts} ${script_type === 'joined' ? 'joined scripts' : (script_type === 'hook' ? 'hooks' : 'bodies')} for this angle.`,
      `\n${typeSpecificInstructions}`,
      sharedVarianceBlock,
      sharedNumberRules,
      scriptModeBlock,
      examplesBlock,
      `\nReturn via the ${TEMPLATE_TOOL_NAMES[script_type]} tool.`,
      extraBlock,
    ].join('')

    // Tool schema enum must match the mode-filtered shape set or the
    // model can pick a shape outside the rotation plan.
    const shapeCodes = effectiveShapes.map((s: any) => s.code)
    const tool = buildTemplateToolSchema(script_type, n_concepts, shapeCodes.length ? shapeCodes : ['_'], hasProofs ? proofNames : [])

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
          script_mode,                          // Ben 2026-06-01 — surface in UI
          teach_focus: s.teach_focus || null,   // populated when n_concepts > 1
          use_mechanism,                        // Ben 2026-06-01 PM — surface in UI
        },
        generated_by_model: ANTHROPIC_MODEL,
        generation_params: { angle_slug, mechanism_slug, script_type, target_shapes, n_concepts, script_mode, use_mechanism },
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
