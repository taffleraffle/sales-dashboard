import { supabase } from '../lib/supabase'

/*
  Ad Analyst Agent client.
  Calls the existing transcript-chat / sales-chat Anthropic-backed endpoint
  (see src/services/transcriptChat.js for the underlying pattern). For the
  ad library, we use a different system prompt + a deterministic data
  pre-fetch keyed to which quick prompt was clicked.

  In prod this proxies through a serverless function so the API key isn't
  exposed in the browser. In dev we call Anthropic directly via env var.
*/

const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY
const ANTHROPIC_MODEL = import.meta.env.VITE_ANTHROPIC_MODEL || 'claude-opus-4-7'

const SYSTEM_PROMPT = `You are the Ad Analyst for OPT Digital — a high-ticket lead-gen agency running Meta ads for restoration / plumbing / pool / remodeling brands.

Your job is to read the data the user provides and answer their question crisply, citing variant_ids and ad_ids as clickable references.

Operating principles you must follow:
- The Andromeda playbook applies: targeting is messaging, 25-30 unique creatives per ad set, 1-3 winners per launch get all the reach (the rest are bench inventory, not waste).
- A favorable CPA can still mean BAD-FIT leads. Always check lead quality / closer-confirmed signals before declaring a winner.
- OPT is sales-team-dependent — recommend 10-30%/day scaling, never aggressive surfing, never breaking closer capacity.
- Cost per booked call < $200 and cost per close < $2,500 are the default in-KPI thresholds.

Voice:
- Tight, declarative. No hedging. No "it depends" without specifics.
- Cite variant_ids in backticks. Use editorial em-dashes — like this — not double dashes.
- Italic *emphasis* sparingly, only when it pulls the eye.
- Numbers always with currency symbol or units. Tabular figures.
- End with a one-line action recommendation when the user is asking "what now."
`

export const QUICK_PROMPTS = [
  {
    id: 'in_kpi',
    label: 'Which ads are in KPI?',
    description: 'Variants currently passing all three KPI thresholds, ranked by booked-call volume.',
    prompt: 'Tell me which variants are currently in KPI for booked calls. Rank by total booked calls, give a one-line reason for each.',
  },
  {
    id: 'top_hook',
    label: 'Best-performing hook this week',
    description: 'Top-scoring phrases in the hook window over the last 7 days.',
    prompt: 'What is the best-performing hook this week? Tell me which variants use it and why it is over-indexing.',
  },
  {
    id: 'why_winning',
    label: 'Why is the top variant winning?',
    description: 'Diagnostic on the highest-spending current winner.',
    prompt: 'Pick the top current "winning" state variant by spend in the last 14 days and tell me — in three short paragraphs — what is driving it: (1) hook signal, (2) body / offer signal, (3) audience pocket signal.',
  },
  {
    id: 'compare_top_bottom',
    label: 'Compare top 3 vs bottom 3',
    description: 'What patterns separate the highest-perf-score variants from the lowest, last 14d.',
    prompt: 'Compare the top 3 and bottom 3 variants by perf_score over the last 14 days. Surface the 3 most distinguishing pattern differences.',
  },
  {
    id: 'next_wave',
    label: 'Suggest next test wave',
    description: '25-30 concept variants drawing on top-performing phrases + Daniel\'s recent prospect-call language.',
    prompt: 'Generate 25 concept variants for the next test wave. Each variant: a one-line hook + a one-line body angle + a scene + a creator. Ground every concept in either (a) a top-decile phrase from our existing ads OR (b) a prospect quote from the recent transcripts I have provided. Number them.',
  },
  {
    id: 'fatiguing',
    label: 'What is fatiguing?',
    description: 'Variants where CPA is climbing >20% over 7-day trailing avg.',
    prompt: 'Identify variants where CPA has climbed more than 20% over the last 7 days versus the trailing 14-day average. Suggest replacements drawn from our bench.',
  },
  {
    id: 'bad_pocket',
    label: 'Why are these leads disqualifying?',
    description: 'Bad-pocket diagnosis — favorable CPA but wrong-fit leads.',
    prompt: 'Look at variants currently flagged as bad_pocket. Diagnose what messaging is pulling in the wrong type of prospect, and propose one phrasing fix per variant.',
  },
]

/**
 * Pre-fetch deterministic data based on the prompt id, then send to Claude
 * with that data pinned into the user message.
 */
export async function runQuickPrompt(promptId, { brand, dateRange } = {}) {
  const promptDef = QUICK_PROMPTS.find(p => p.id === promptId)
  if (!promptDef) throw new Error(`Unknown prompt: ${promptId}`)

  const context = await fetchContextForPrompt(promptId, { brand, dateRange })
  const userMsg = `${promptDef.prompt}\n\n=== Data context ===\n${JSON.stringify(context, null, 2)}`

  return chat([{ role: 'user', content: userMsg }])
}

/**
 * Open chat — full history pass-through. Caller appends the new turn.
 * Streams tokens via async generator so the UI can render incrementally.
 */
export async function* chatStream(messages) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key not configured. Set VITE_ANTHROPIC_API_KEY in .env to enable the analyst.')
  }

  // Hard guard: VITE_* env vars get bundled into the client JS at build time.
  // In production that means anyone with dashboard access can extract the key
  // from devtools. The serverless proxy isn't built yet — until it is, refuse
  // to ship this in PROD builds. Internal-only dev/preview use is fine.
  if (import.meta.env.PROD && !import.meta.env.VITE_ALLOW_DIRECT_ANTHROPIC) {
    throw new Error(
      'Direct browser → Anthropic calls are disabled in production (key would leak). ' +
      'Build a serverless proxy and route through that, or set VITE_ALLOW_DIRECT_ANTHROPIC=1 if your dashboard is internal-only and trusted.'
    )
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages,
      stream: true,
    }),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`Anthropic API error: ${res.status} ${err.slice(0, 200)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data)
        if (json.type === 'content_block_delta' && json.delta?.text) {
          yield json.delta.text
        } else if (json.type === 'error') {
          throw new Error(`Anthropic stream error: ${json.error?.message || JSON.stringify(json)}`)
        }
      } catch (e) {
        // Surface parse failures rather than silently dropping content.
        // Per CLAUDE.md "surface errors, never swallow."
        console.warn('[adAnalyst] SSE parse failed for line:', data.slice(0, 200), e.message)
      }
    }
  }
}

/** Non-streaming convenience for prompts that need the full reply at once. */
async function chat(messages) {
  let full = ''
  for await (const chunk of chatStream(messages)) full += chunk
  return full
}

/**
 * Pull the right slice of data for each quick prompt. All read-only — agent
 * cannot mutate ads in v1.
 */
async function fetchContextForPrompt(promptId, { dateRange }) {
  // For now, every prompt gets a slim ad pool snapshot. Specific prompts can
  // request additional joins below. `brand` filter not yet wired — when it
  // lands it'll filter ads by brand metadata via public.ads.brand.
  const since = dateRangeStart(dateRange)
  const adsRes = await supabase
    .from('ads')
    .select('ad_id, ad_name, variant_id, status, first_seen_at')
    .order('first_seen_at', { ascending: false })
    .limit(500)
  const ads = adsRes.data || []

  // Aggregate stats from ad_daily_stats
  const adIds = ads.map(a => a.ad_id)
  let stats = []
  if (adIds.length) {
    const statsRes = await supabase
      .from('ad_daily_stats')
      .select('ad_id, date, spend, impressions, clicks, results')
      .in('ad_id', adIds)
      .gte('date', since)
    stats = statsRes.data || []
  }

  // Aggregate per ad
  const perAd = {}
  for (const ad of ads) perAd[ad.ad_id] = { ad_id: ad.ad_id, ad_name: ad.ad_name, variant_id: ad.variant_id, spend: 0, impressions: 0, clicks: 0, leads: 0 }
  for (const s of stats) {
    const row = perAd[s.ad_id]
    if (!row) continue
    row.spend += parseFloat(s.spend || 0)
    row.impressions += parseInt(s.impressions || 0)
    row.clicks += parseInt(s.clicks || 0)
    row.leads += parseInt(s.results || 0)
  }
  const aggregated = Object.values(perAd).filter(r => r.spend > 0)

  // Build the context object incrementally so each prompt id can layer on
  // exactly what it needs without a control-flow trap (the previous version
  // returned early on top_hook||next_wave, making the next_wave transcripts
  // branch unreachable).
  const context = { ads: aggregated, since }

  if (promptId === 'top_hook' || promptId === 'next_wave') {
    const phrasesRes = await supabase
      .from('lib_phrase_performance')
      .select('phrase, ngram_size, window_kind, mean_perf_score, delta_vs_library, variants_count, total_spend')
      .eq('window_kind', promptId === 'top_hook' ? 'hook' : 'full')
      .order('delta_vs_library', { ascending: false })
      .limit(40)
    if (phrasesRes.error) {
      console.warn('[adAnalyst] phrase fetch failed:', phrasesRes.error.message)
    }
    context.phrases = phrasesRes.data || []
  }

  if (promptId === 'next_wave') {
    // Daniel's recent prospect-only transcripts (exclude team meeting +
    // Constantine @ scaleclients.io per Ben 2026-05-10).
    const trRes = await supabase
      .from('closer_transcripts')
      .select('prospect_name, prospect_email, meeting_date, summary')
      .eq('closer_id', '76f61d92-83d8-45ec-87a7-82b0dc6d607e')
      .not('prospect_email', 'ilike', '%scaleclients.io%')
      .not('prospect_email', 'is', null)
      .gte('meeting_date', since)
      .order('meeting_date', { ascending: false })
      .limit(20)
    if (trRes.error) {
      console.warn('[adAnalyst] transcript fetch failed:', trRes.error.message)
    }
    context.transcripts = trRes.data || []
  }

  return context
}

function dateRangeStart(range) {
  if (!range) range = 14
  const d = new Date()
  d.setDate(d.getDate() - (typeof range === 'number' ? range : 14))
  return d.toISOString().split('T')[0]
}
