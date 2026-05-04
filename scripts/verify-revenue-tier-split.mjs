// For every strategy booking in the trailing 7 days, look up the contact's
// monthly-revenue custom field on the GHL contact record. Classify each
// booking as qualified (≥$30k) or DQ ($0-$30k) based on that. Report.

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

const STRAT = ['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0','gohFzPCilzwBtVfaC6fu']
const REVENUE_FIELD = 'Tb6fklGYdWcgl9vUS2q9'
const from7d = '2026-04-28', to7d = '2026-05-04'

const { data: rows } = await supabase
  .from('ghl_appointments')
  .select('contact_name, ghl_contact_id, calendar_name, booked_at, appointment_date')
  .in('calendar_name', STRAT)
  .neq('appointment_status', 'cancelled')
  .gte('booked_at', from7d)
  .lte('booked_at', to7d + ' 23:59:59')

const isDQ = v => /\$\s*0\s*[-–]\s*\$?\s*30/i.test(v || '')

let qualified = 0, dq = 0, unknown = 0
console.log(`\n=== Classifying ${rows?.length || 0} 7d bookings by contact revenue tier ===\n`)
console.log(`name                                          calendar  revenue_tier            class`)
console.log(`--------------------------------------------- --------  ----------------------- -----`)
for (const r of rows || []) {
  if (!r.ghl_contact_id) { unknown++; console.log(`${(r.contact_name || '').padEnd(45)}  ${r.calendar_name.slice(0,8)}  (no contact id)         UNKNOWN`); continue }
  const cr = await fetch(`${BASE}/contacts/${r.ghl_contact_id}`, { headers })
  if (!cr.ok) { unknown++; console.log(`${(r.contact_name || '').padEnd(45)}  ${r.calendar_name.slice(0,8)}  (HTTP ${cr.status})              UNKNOWN`); continue }
  const cj = await cr.json()
  const c = cj.contact || cj
  const rev = (c.customFields || []).find(f => f.id === REVENUE_FIELD)?.value || '(none)'
  const cls = rev === '(none)' ? 'UNKNOWN' : (isDQ(rev) ? 'DQ' : 'QUALIFIED')
  if (cls === 'DQ') dq++
  else if (cls === 'QUALIFIED') qualified++
  else unknown++
  console.log(`${(r.contact_name || '').padEnd(45)}  ${r.calendar_name.slice(0,8)}  ${rev.padEnd(23)} ${cls}`)
}

console.log(`\n=== Summary (last 7d, ${from7d} → ${to7d}) ===`)
console.log(`Qualified: ${qualified}`)
console.log(`DQ:        ${dq}`)
console.log(`Unknown:   ${unknown}`)
console.log(`Total:     ${qualified + dq + unknown}`)
