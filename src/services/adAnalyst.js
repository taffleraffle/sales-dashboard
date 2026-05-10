import { supabase } from '../lib/supabase'

/*
  Ad Analyst client. Calls the `ad-analyst` Supabase Edge Function so the
  Anthropic key stays server-side (Supabase secrets), never in the browser
  bundle.

  Two modes:
    runQuickPrompt(id)  — deterministic data fetch + single LLM call
    chatStream(msgs)    — streams an open chat reply

  Edge Function source: supabase/functions/ad-analyst/index.ts
*/

export const QUICK_PROMPTS = [
  { id: 'in_kpi',            label: 'Which ads are in KPI?',          description: 'Variants currently passing all three KPI thresholds, ranked by booked-call volume.' },
  { id: 'top_hook',          label: 'Best-performing hook this week', description: 'Top-scoring phrases in the hook window over the last 7 days.' },
  { id: 'why_winning',       label: 'Why is the top variant winning?', description: 'Diagnostic on the highest-spending current winner.' },
  { id: 'compare_top_bottom',label: 'Compare top 3 vs bottom 3',       description: 'What patterns separate the highest-perf-score variants from the lowest, last 14d.' },
  { id: 'next_wave',         label: 'Suggest next test wave',          description: '25 concept variants grounded in top phrases + Daniel\'s recent prospect-call language.' },
  { id: 'fatiguing',         label: 'What is fatiguing?',              description: 'Variants where CPA is climbing >20% over 7-day trailing avg.' },
  { id: 'bad_pocket',        label: 'Why are these leads disqualifying?', description: 'Bad-pocket diagnosis — favorable CPA but wrong-fit leads.' },
]

/** Quick prompt — single round-trip, returns the full reply text. */
export async function runQuickPrompt(promptId, { dateRange } = {}) {
  const { data, error } = await supabase.functions.invoke('ad-analyst', {
    body: { mode: 'quick', promptId, dateRange },
  })
  if (error) throw new Error(error.message || 'ad-analyst quick failed')
  if (data?.error) throw new Error(data.error)
  return data?.reply || ''
}

/** Open chat — async generator that yields token chunks as they stream. */
export async function* chatStream(messages) {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ad-analyst`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ mode: 'chat', messages }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`ad-analyst chat error: ${res.status} ${err.slice(0, 200)}`)
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
        console.warn('[adAnalyst] SSE parse failed for line:', data.slice(0, 200), e.message)
      }
    }
  }
}

/** Fire the transcribe-ads Edge Function (Whisper backfill). */
export async function triggerTranscribeAds(maxRun = 25) {
  const { data, error } = await supabase.functions.invoke('transcribe-ads', {
    body: { maxRun },
  })
  if (error) throw new Error(error.message || 'transcribe-ads failed')
  if (data?.error) throw new Error(data.error)
  return data
}
