// Backfill revenue_tier on every existing ghl_appointments row by looking up
// the contact's monthly-revenue custom field in GHL. Run once after the
// migration for column 025_add_revenue_tier_to_ghl_appointments.sql lands.
//
// Idempotent — only fetches contacts for rows where revenue_tier is null.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)
const BASE = 'https://services.leadconnectorhq.com'
const headers = { Authorization: `Bearer ${env.VITE_GHL_API_KEY}`, Version: '2021-07-28' }
const REVENUE_FIELD = 'Tb6fklGYdWcgl9vUS2q9'

// Pull every appointment that doesn't yet have a revenue tier and has a
// contact id we can look up. Cap to last 90 days to keep this snappy.
const since = (() => { const d = new Date(); d.setDate(d.getDate() - 90); return d.toISOString().split('T')[0] })()
const { data: rows, error } = await supabase
  .from('ghl_appointments')
  .select('ghl_event_id, ghl_contact_id, revenue_tier')
  .gte('appointment_date', since)
  .is('revenue_tier', null)
  .not('ghl_contact_id', 'eq', '')
if (error) {
  if (error.message.includes('revenue_tier')) {
    console.error('\n❌ The `revenue_tier` column does not exist yet.\n   Run migration 025 in Supabase SQL Editor first:\n')
    console.error('   ALTER TABLE ghl_appointments ADD COLUMN IF NOT EXISTS revenue_tier text;')
    console.error("   NOTIFY pgrst, 'reload schema';\n")
    process.exit(1)
  }
  console.error('Query failed:', error)
  process.exit(1)
}
console.log(`Rows needing revenue_tier: ${rows.length}`)

// Cache by contact id so we don't refetch for the same prospect
const tierByContactId = {}
const uniqueContactIds = [...new Set(rows.map(r => r.ghl_contact_id))]
console.log(`Fetching ${uniqueContactIds.length} unique contacts...`)

let done = 0, withTier = 0
for (const id of uniqueContactIds) {
  done++
  if (done % 25 === 0) console.log(`  ${done}/${uniqueContactIds.length}`)
  try {
    const r = await fetch(`${BASE}/contacts/${id}`, { headers })
    if (!r.ok) continue
    const j = await r.json()
    const c = j.contact || j
    const field = (c.customFields || []).find(f => f.id === REVENUE_FIELD)
    if (field?.value) {
      tierByContactId[id] = field.value
      withTier++
    }
  } catch (e) {
    console.warn(`  ${id}: ${e.message}`)
  }
}
console.log(`\nGot revenue tier for ${withTier}/${uniqueContactIds.length} contacts`)

// Update rows in batches
let updated = 0
for (const row of rows) {
  const tier = tierByContactId[row.ghl_contact_id]
  if (!tier) continue
  const { error: upErr } = await supabase
    .from('ghl_appointments')
    .update({ revenue_tier: tier })
    .eq('ghl_event_id', row.ghl_event_id)
  if (upErr) { console.warn(`Update failed ${row.ghl_event_id}: ${upErr.message}`); continue }
  updated++
}
console.log(`\nUpdated ${updated} appointment rows with revenue_tier`)

// Quick verification
const { data: sample } = await supabase
  .from('ghl_appointments')
  .select('revenue_tier')
  .gte('appointment_date', since)
  .not('revenue_tier', 'is', null)
console.log(`\nTotal rows with revenue_tier in last 90d: ${sample?.length || 0}`)
