// ad-analyst — Supabase Edge Function
//
// Server-side proxy for the Ad Analyst panel. Keeps ANTHROPIC_API_KEY out of
// the browser bundle. Two modes:
//   { mode: 'quick',  promptId, dateRange? }   — runs a deterministic data
//                                                 fetch + a single LLM call,
//                                                 returns the full reply.
//   { mode: 'chat',   messages }                — streams an open-chat reply
//                                                 (SSE passthrough to Claude).
//
// Secrets required:
//   - ANTHROPIC_API_KEY        Anthropic key (already in Supabase secrets — used by sales-chat)
//   - SUPABASE_URL             auto-provided
//   - SUPABASE_SERVICE_ROLE_KEY auto-provided
//
// CORS via _shared/cors.ts (allowed: render.com prod + localhost dev).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { handleCors, getCorsHeaders } from '../_shared/cors.ts'

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

  // ─── chat mode: stream the response ───
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

  // ─── quick mode: deterministic data fetch + non-streaming reply ───
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

  return json({ error: 'mode must be "quick" or "chat"' }, 400)
})

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
    // Daniel's prospect calls only (exclude OPT team meeting + Constantine @ scaleclients.io per Ben 2026-05-10)
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
