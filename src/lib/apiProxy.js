import { supabase } from './supabase'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL

/**
 * Call third-party APIs through the server-side proxy edge function.
 * API keys are stored server-side only — never in the browser bundle.
 */
export async function apiProxy(service, action, params = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  const res = await fetch(`${SUPABASE_URL}/functions/v1/api-proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ service, action, params }),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Proxy error: ${res.status}`)
  return data
}
