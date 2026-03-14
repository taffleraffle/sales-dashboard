import { supabase } from '../lib/supabase'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Trigger objection analysis via Supabase Edge Function.
 * Analyzes Fathom transcripts with Claude and stores results in objection_analysis table.
 */
export async function analyzeObjections(closerId = null, days = 30) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/analyze-objections`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ closer_id: closerId, days }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Edge function error: ${res.status}`)
  }

  return res.json()
}
