// Final check: per-row revenue tier on every 7d strategy booking + the
// resulting qualified/DQ split using the new column.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

const STRAT = ['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0','gohFzPCilzwBtVfaC6fu']
const DQ_CALENDARS = ['gohFzPCilzwBtVfaC6fu']
const isDQ = v => v && /^\$\s*0/.test(String(v).trim())

const from7d = '2026-04-28', to7d = '2026-05-04'
const { data: rows } = await supabase
  .from('ghl_appointments')
  .select('contact_name, calendar_name, booked_at, revenue_tier')
  .in('calendar_name', STRAT)
  .neq('appointment_status', 'cancelled')
  .gte('booked_at', from7d)
  .lte('booked_at', to7d + ' 23:59:59')

console.log(`\n=== 7d strategy bookings (${from7d} → ${to7d}) ===\n`)
console.log(`name                                            cal       revenue_tier        class`)
console.log(`----------------------------------------------- --------  ------------------- -----`)
let q = 0, dq = 0, qNoTier = 0, dqNoTier = 0
for (const r of rows || []) {
  const tier = r.revenue_tier
  const calIsDq = DQ_CALENDARS.includes(r.calendar_name)
  let cls
  if (tier) cls = isDQ(tier) ? 'DQ' : 'QUAL'
  else cls = calIsDq ? 'DQ*' : 'QUAL*'  // * = inferred from calendar fallback
  if (cls === 'QUAL') q++
  else if (cls === 'DQ') dq++
  else if (cls === 'QUAL*') qNoTier++
  else if (cls === 'DQ*') dqNoTier++
  console.log(`${(r.contact_name || '').padEnd(47)}  ${r.calendar_name.slice(0,8)}  ${(tier || '(none)').padEnd(19)} ${cls}`)
}
console.log(`\n=== Summary ===`)
console.log(`Qualified (by revenue):     ${q}`)
console.log(`DQ (by revenue):            ${dq}`)
console.log(`Qualified (calendar fallback): ${qNoTier}`)
console.log(`DQ (calendar fallback):     ${dqNoTier}`)
console.log(`────────────────────────────`)
console.log(`Total qualified:            ${q + qNoTier}`)
console.log(`Total DQ:                   ${dq + dqNoTier}`)
console.log(`Total bookings:             ${(rows || []).length}`)
