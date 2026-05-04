// Compare qualified_bookings bucketed by appointment_date vs booked_at to
// understand the lead/booking timing mismatch.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

const STRAT = ['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0','gohFzPCilzwBtVfaC6fu']

const { data } = await supabase
  .from('ghl_appointments')
  .select('appointment_date, booked_at')
  .in('calendar_name', STRAT)
  .neq('appointment_status', 'cancelled')

const byApptDate = {}, byBookedDate = {}
for (const r of data || []) {
  if (r.appointment_date) byApptDate[r.appointment_date] = (byApptDate[r.appointment_date] || 0) + 1
  if (r.booked_at) {
    const bd = String(r.booked_at).split('T')[0].split(' ')[0]
    if (bd) byBookedDate[bd] = (byBookedDate[bd] || 0) + 1
  }
}

const dates = [...new Set([...Object.keys(byApptDate), ...Object.keys(byBookedDate)])].sort()
const last30 = (() => { const s = new Date(); s.setDate(s.getDate() - 30); return s.toISOString().split('T')[0] })()
const last7 = (() => { const s = new Date(); s.setDate(s.getDate() - 7); return s.toISOString().split('T')[0] })()

console.log('Date         by_appt  by_booked  diff')
let totApptW7 = 0, totBookedW7 = 0, totApptW30 = 0, totBookedW30 = 0
for (const d of dates) {
  if (d < last30) continue
  const a = byApptDate[d] || 0, b = byBookedDate[d] || 0
  console.log(`  ${d}  ${String(a).padStart(7)}  ${String(b).padStart(9)}  ${a !== b ? `(${a > b ? '+' : ''}${a - b})` : ''}`)
  totApptW30 += a; totBookedW30 += b
  if (d >= last7) { totApptW7 += a; totBookedW7 += b }
}

console.log(`\n30d total:  by_appt=${totApptW30}  by_booked=${totBookedW30}`)
console.log(`7d  total:  by_appt=${totApptW7}  by_booked=${totBookedW7}`)

// And check leads in same windows
const { data: leadRows } = await supabase
  .from('marketing_tracker')
  .select('date, leads')
  .gte('date', last30)
  .order('date')
const leads30 = (leadRows || []).reduce((s, r) => s + (r.leads || 0), 0)
const leads7 = (leadRows || []).filter(r => r.date >= last7).reduce((s, r) => s + (r.leads || 0), 0)
console.log(`\nLeads:   30d=${leads30}  7d=${leads7}`)
