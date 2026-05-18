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

/** Fire the transcribe-ads Edge Function (Whisper backfill of /advideos catalog). */
export async function triggerTranscribeAds(maxRun = 25) {
  const { data, error } = await supabase.functions.invoke('transcribe-ads', {
    body: { maxRun },
  })
  if (error) throw new Error(error.message || 'transcribe-ads failed')
  if (data?.error) throw new Error(data.error)
  return data
}

/**
 * Upload a source MP4 for a specific ad → Storage → invoke
 * transcribe-uploaded-ad Edge Function which Whispers it and stores the
 * transcript keyed by ad_id (so phrase scoring can use it).
 *
 * Returns the function response with transcript_preview, duration, etc.
 */
export async function uploadAndTranscribeAdVideo(adId, file) {
  const path = await uploadAdVideoToStorage(adId, file)
  return transcribeUploadedAd(adId, path)
}

/**
 * Step 1 of the upload-creative flow. Uploads the MP4 to the
 * ad-source-videos bucket. Returns the storage path. Fast (~5-15s).
 */
export async function uploadAdVideoToStorage(adId, file) {
  if (!adId) throw new Error('ad_id required')
  if (!file) throw new Error('file required')
  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase()
  const path = `${adId}.${ext}`
  const upRes = await supabase.storage
    .from('ad-source-videos')
    .upload(path, file, { upsert: true, contentType: file.type || 'video/mp4' })
  if (upRes.error) throw new Error(`upload failed: ${upRes.error.message}`)
  return path
}

/**
 * Step 2 of the upload-creative flow. Invokes the transcribe-uploaded-ad
 * Edge Function. Whisper transcription is slow (~30-120s for typical ads).
 *
 * Uses a manual fetch with explicit timeout because supabase-js's
 * functions.invoke default fetch can fail spuriously on slow Edge
 * Functions.
 */
export async function transcribeUploadedAd(adId, storagePath, { timeoutMs = 180_000 } = {}) {
  if (!adId) throw new Error('ad_id required')
  if (!storagePath) throw new Error('storage_path required')

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/transcribe-uploaded-ad`
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ ad_id: adId, storage_path: storagePath }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`transcribe ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = await res.json()
    if (data?.error) throw new Error(data.error)
    return data
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Transcription timed out after ${timeoutMs / 1000}s. The file may be too long — try a shorter clip or contact support.`)
    }
    throw e
  } finally {
    clearTimeout(t)
  }
}
