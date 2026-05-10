// ad-analyst — Supabase Edge Function
//
// Server-side proxy for the Ad Analyst panel. Keeps ANTHROPIC_API_KEY out of
// the browser bundle.
//   { mode: 'quick',  promptId, dateRange? }  — non-streaming reply
//   { mode: 'chat',   messages }               — streamed SSE passthrough

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// CORS inlined
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

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-4-20250514'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const SYSTEM_PROMPT = `You are the Ad Analyst for OPT Digital — a high-ticket lead-gen agency running Meta ads for restoration / plumbing / pool / remodeling brands.

Your job: read the data the user provides, answer their question crisply, cite variant_ids and ad_ids as clickable references.

Operating principles:
- Andromeda playbook applies: targeting is messaging, 25-30 unique creatives per ad set, 1-3 winners per launch get all the reach (the rest are bench inventory, not waste).
- A favorable CPA can still mean BAD-FIT leads. Always check lead quality / closer-confirmed signals before declaring a winner.
- OPT is sales-team-dependent — recommend 10-30%/day scaling, never aggressive surfing.
- Cost per booked call < $200 and cost per close < $2,500 are default in-KPI thresholds.

Voice:
- Tight, declarative. No hedging. Cite variant_ids in backticks.
- Use editorial em-dashes — like this — not double dashes.
- Italic *emphasis* sparingly. Numbers always with currency + tabular figures.
- End with a one-line action recommendation when the user asks "what now."`

const MESSAGING_SYSTEM_PROMPT = `You are a senior messaging strategist for OPT Digital, applying Jeremy Haynes' framework for paid-ads messaging.

WHO OPT SELLS TO (this is fixed — do not invent other audiences):
- Owners of restoration, plumbing, pool, and remodeling companies.
- Service contractors typically doing $20k–$200k/mo in revenue.
- They run their own business, they answer their own phone, they care about
  job quality and lead volume. They are NOT agency owners, NOT general SMBs,
  NOT coaches or info-product buyers.

JEREMY HAYNES' THREE PERSPECTIVES for any messaging angle:
  1. PROBLEMS      — what's actively painful, broken, embarrassing right now
  2. CIRCUMSTANCES — the specific business situation they're sitting in
  3. OUTCOMES     — the state they actually want to be in (vivid, specific)

YOUR JOB
Read the transcripts and phrase data you receive. Identify the **three** most
distinct messaging angles that emerge from the language prospects ACTUALLY use.
Don't invent angles — pull them from the data. Each topic must be supported by
multiple verbatim quotes; if you can only find one quote for an angle, drop the
angle and pick a stronger one.

OUTPUT FORMAT (exactly three topics, structured as below):

## Topic 1: [Specific angle name in 3-6 words]
**Why this angle works**
One short paragraph (2-3 sentences) explaining what makes this angle land,
anchored in what's recurring in the transcripts.

**The problem in their words**
- "Verbatim quote from a real transcript"
- "Another verbatim quote"
- "Third verbatim quote"
(3-5 quotes, real, attributed only to the words themselves — no names)

**Their circumstances**
- 3-4 short bullets describing the business context
- Revenue stage, what they've tried, what's recently shifted

**The outcome they want**
- 3-4 short bullets describing the state they're chasing
- Specific numbers when prospects mention them

**Hook lines we could test**
- 4-6 one-line ad hook ideas grounded in the above
- Lift prospect phrasings where powerful — don't paraphrase to "make it pretty"

## Topic 2: [...]
(same structure)

## Topic 3: [...]
(same structure)

VOICE RULES (hard):
- Pull quotes verbatim. Don't summarize them into prettier prose.
- No marketing-speak ("level up", "crush it", "unleash", "unlock") unless
  prospects themselves use the word.
- No "X isn't Y, it's Z" reframes. No "Here's the trap…" / "Most owners
  never…" aphorisms. No textbook openers.
- Editorial em-dashes — like this — not double-dashes.
- Don't pad. If a section is short, it's short.`

const QUICK_PROMPTS: Record<string, string> = {
  in_kpi:            'Tell me which variants are currently in KPI for booked calls. Rank by total booked calls, give a one-line reason for each.',
  top_hook:          'What is the best-performing hook this week? Tell me which variants use it and why it is over-indexing.',
  why_winning:       'Pick the top current "winning" state variant by spend in the last 14 days and tell me — in three short paragraphs — what is driving it: (1) hook signal, (2) body / offer signal, (3) audience pocket signal.',
  compare_top_bottom:'Compare the top 3 and bottom 3 variants by perf_score over the last 14 days. Surface the 3 most distinguishing pattern differences.',
  next_wave:         'Generate 25 concept variants for the next test wave. Each variant: a one-line hook + a one-line body angle + a scene + a creator. Ground every concept in either (a) a top-decile phrase from our existing ads OR (b) a prospect quote from the recent transcripts I have provided. Number them.',
  fatiguing:         'Identify variants where CPA has climbed more than 20% over the last 7 days versus the trailing 14-day average. Suggest replacements drawn from our bench.',
  bad_pocket:        'Look at variants currently flagged as bad_pocket. Diagnose what messaging is pulling in the wrong type of prospect, and propose one phrasing fix per variant.',
}

serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors
  const corsHeaders = getCorsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_API_KEY not set in Supabase secrets' }, 500)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }
  const mode = body?.mode

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  if (mode === 'chat') {
    const messages = body.messages
    if (!Array.isArray(messages) || !messages.length) return json({ error: 'messages array required' }, 400)
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL, max_tokens: 1500,
        system: SYSTEM_PROMPT, messages, stream: true,
      }),
    })
    if (!upstream.ok) {
      const err = await upstream.text()
      return json({ error: `Anthropic: ${upstream.status} ${err.slice(0, 200)}` }, 502)
    }
    return new Response(upstream.body, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }

  if (mode === 'quick') {
    const promptId = body.promptId
    const promptText = QUICK_PROMPTS[promptId]
    if (!promptText) return json({ error: `unknown promptId: ${promptId}` }, 400)

    const context = await buildContext(supabase, promptId, body.dateRange)
    const userMsg = `${promptText}\n\n=== Data context ===\n${JSON.stringify(context, null, 2)}`

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL, max_tokens: 2000,
        system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userMsg }],
      }),
    })
    if (!upstream.ok) {
      const err = await upstream.text()
      return json({ error: `Anthropic: ${upstream.status} ${err.slice(0, 200)}` }, 502)
    }
    const j = await upstream.json()
    const reply = j.content?.[0]?.text || ''
    return json({ ok: true, reply, usage: j.usage })
  }

  // ─── messaging_topics mode: 3 Jeremy-Haynes topics auto-derived from transcripts ───
  // No user inputs. The audience is fixed (OPT's contractor service prospects)
  // and surfaced from the transcripts themselves. Caller can optionally pass
  // { days: 90 } to widen the transcript window; default 90.
  if (mode === 'messaging_topics') {
    const days = typeof body.days === 'number' ? body.days : 90
    const context = await buildIdeationContext(supabase, days)
    if (!context.transcripts.length) {
      return json({ error: 'No prospect transcripts found in window — check closer_transcripts table' }, 422)
    }

    const userMsg = `Generate three messaging topics for OPT Digital based on the actual prospect language in the data below. No audience description is provided — the audience is fixed (restoration / plumbing / pool / remodeling contractors). Identify the three strongest angles in the transcripts and structure each one per the system prompt.

=== Daniel's prospect-call transcripts (last ${days} days, ${context.transcripts.length} calls) ===
${JSON.stringify(context.transcripts, null, 2)}

=== Top-decile phrases from OUR live ad copy ===
${JSON.stringify(context.topPhrases, null, 2)}

=== Spoken transcripts from OUR filmed creatives (brand voice corpus) ===
${JSON.stringify(context.spokenTranscripts, null, 2)}

Produce exactly three topics, in the exact format the system prompt specifies.`

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL, max_tokens: 4000,
        system: MESSAGING_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      }),
    })
    if (!upstream.ok) {
      const err = await upstream.text()
      return json({ error: `Anthropic: ${upstream.status} ${err.slice(0, 200)}` }, 502)
    }
    const j = await upstream.json()
    const reply = j.content?.[0]?.text || ''
    return json({
      ok: true,
      reply,
      usage: j.usage,
      transcript_count: context.transcripts.length,
      phrase_count: context.topPhrases.length,
    })
  }

  return json({ error: 'mode must be quick / chat / messaging_topics' }, 400)
})

// ── Builder: pull transcripts + phrase data for the messaging-topics mode ──
// Pulls the Fathom summary field rather than just a name/date stub — the
// summaries contain bracketed verbatim quotes from the prospect which the
// system prompt explicitly requires for grounded output.
async function buildIdeationContext(supabase: any, days: number) {
  const since = (() => {
    const d = new Date(); d.setDate(d.getDate() - days)
    return d.toISOString().split('T')[0]
  })()
  const trRes = await supabase.from('closer_transcripts')
    .select('prospect_name, prospect_email, meeting_date, duration_seconds, summary, outcome, objections')
    .eq('closer_id', '76f61d92-83d8-45ec-87a7-82b0dc6d607e')
    .not('prospect_email', 'ilike', '%scaleclients.io%')
    .not('prospect_email', 'is', null)
    .not('summary', 'is', null)
    .gte('meeting_date', since)
    .order('meeting_date', { ascending: false }).limit(25)

  // Top phrases from existing ad copy (carries weight signal — high
  // delta_vs_library = phrases that over-index for booking conversion)
  const phRes = await supabase.from('lib_phrase_performance')
    .select('phrase, ngram_size, mean_perf_score, delta_vs_library, variants_count, total_spend')
    .order('delta_vs_library', { ascending: false }).limit(30)

  // Spoken transcripts (brand voice corpus from C2)
  const spRes = await supabase.from('lib_creative_transcripts')
    .select('meta_video_id, duration_sec, full_text')
    .eq('source', 'whisper_api')
    .not('full_text', 'is', null)
    .limit(30)

  return {
    transcripts: trRes.data || [],
    topPhrases: phRes.data || [],
    spokenTranscripts: (spRes.data || []).filter((r: any) => r.full_text && r.full_text.length > 50),
  }
}

async function buildContext(supabase: any, promptId: string, dateRange: any) {
  const since = (() => {
    const d = new Date(); d.setDate(d.getDate() - (typeof dateRange === 'number' ? dateRange : 14))
    return d.toISOString().split('T')[0]
  })()

  const adsRes = await supabase.from('ads')
    .select('ad_id, ad_name, variant_id, status, first_seen_at')
    .order('first_seen_at', { ascending: false }).limit(500)
  const ads = adsRes.data || []
  const adIds = ads.map((a: any) => a.ad_id)

  let stats: any[] = []
  if (adIds.length) {
    const sRes = await supabase.from('ad_daily_stats')
      .select('ad_id, date, spend, impressions, clicks, results')
      .in('ad_id', adIds).gte('date', since)
    stats = sRes.data || []
  }

  const perAd: Record<string, any> = {}
  for (const a of ads) perAd[a.ad_id] = { ad_id: a.ad_id, ad_name: a.ad_name, variant_id: a.variant_id, spend: 0, impressions: 0, clicks: 0, leads: 0 }
  for (const s of stats) {
    const r = perAd[s.ad_id]
    if (!r) continue
    r.spend += parseFloat(s.spend || 0)
    r.impressions += parseInt(s.impressions || 0)
    r.clicks += parseInt(s.clicks || 0)
    r.leads += parseInt(s.results || 0)
  }
  const aggregated = Object.values(perAd).filter((r: any) => r.spend > 0)
  const context: any = { ads: aggregated, since }

  if (promptId === 'top_hook' || promptId === 'next_wave') {
    const phrasesRes = await supabase.from('lib_phrase_performance')
      .select('phrase, ngram_size, window_kind, mean_perf_score, delta_vs_library, variants_count, total_spend')
      .order('delta_vs_library', { ascending: false }).limit(40)
    context.phrases = phrasesRes.data || []
  }

  if (promptId === 'next_wave') {
    const trRes = await supabase.from('closer_transcripts')
      .select('prospect_name, prospect_email, meeting_date, summary')
      .eq('closer_id', '76f61d92-83d8-45ec-87a7-82b0dc6d607e')
      .not('prospect_email', 'ilike', '%scaleclients.io%')
      .not('prospect_email', 'is', null)
      .gte('meeting_date', since)
      .order('meeting_date', { ascending: false }).limit(20)
    context.transcripts = trRes.data || []
  }

  return context
}
