import { supabase } from './supabase'

/* Saved deals for the Closer Hub checklist. Row-level security limits reads
   and writes to the closer's own deals, and admins see all. */

export async function listOpenDeals() {
  const { data, error } = await supabase.from('closer_hub_deals').select('*')
    .eq('status', 'open').order('updated_at', { ascending: false }).limit(12)
  if (error) throw error
  return data || []
}

export async function createDeal(fields, user) {
  const row = { ...fields, created_by: user.id, closer_name: user.name || user.email || '', updated_at: new Date().toISOString() }
  const { data, error } = await supabase.from('closer_hub_deals').insert(row).select('*').single()
  if (error) throw error
  return data
}

export async function updateDeal(id, patch) {
  const { data, error } = await supabase.from('closer_hub_deals').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select('*').single()
  if (error) throw error
  return data
}
