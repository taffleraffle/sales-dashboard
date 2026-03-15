const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Sync Fathom meetings via Supabase Edge Function.
 * The edge function handles the Fathom API call server-side (avoids CORS),
 * matches meetings to closers by email, and inserts into closer_transcripts.
 */
export async function syncFathomTranscripts() {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/sync-fathom`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Edge function error: ${res.status}`)
  }

  return res.json()
}
