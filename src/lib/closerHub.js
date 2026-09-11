import { supabase } from './supabase'

/* One door to the closer-hub edge function. Every action needs the caller's
   session: the function checks they are a closer or an admin. */
export async function callCloserHub(action, body = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')
  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/closer-hub`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action, ...body }),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const err = new Error(data.error || `${action} failed (${resp.status})`)
    err.status = resp.status
    err.data = data
    throw err
  }
  return data
}

export async function loadCloserHubSettings() {
  const { data, error } = await supabase.from('closer_hub_settings').select('key, value')
  if (error) throw error
  const out = {}
  for (const row of data || []) out[row.key] = row.value || ''
  return out
}

export async function saveCloserHubSettings(values) {
  const rows = Object.entries(values).map(([key, value]) => ({ key, value: value ?? '', updated_at: new Date().toISOString() }))
  const { error } = await supabase.from('closer_hub_settings').upsert(rows, { onConflict: 'key' })
  if (error) throw error
}
