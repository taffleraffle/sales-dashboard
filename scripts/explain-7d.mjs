// Show exactly what numbers fall into the user's "last 7d" view, both ways.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)
const STRAT = ['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0','gohFzPCilzwBtVfaC6fu']

// User is in NZ — page uses browser local time. NZ today is one day ahead of UTC for ~half the day.
// Their "last 7 days" = today_NZ - 7 to today_NZ, inclusive.
// Show both Apr 27-May 4 (UTC interpretation) and Apr 28-May 4 (NZ interpretation).

console.log('=== Strategy bookings in window — by appointment_date vs booked_at ===\n')
const { data: appts } = await supabase.from('ghl_appointments').select('booked_at, appointment_date, contact_name, calendar_name').in('calendar_name', STRAT).neq('appointment_status','cancelled')

const inWindow = (date, from, to) => date >= from && date <= to
const wk1Start = '2026-04-28', wk1End = '2026-05-04'  // Ben's NZ-local "last 7 days"

let appt7 = 0, booked7 = 0
const apptList = [], bookedList = []
for (const a of appts || []) {
  const apptDate = a.appointment_date
  const bookedDate = a.booked_at ? String(a.booked_at).split(' ')[0].split('T')[0] : null
  if (apptDate && inWindow(apptDate, wk1Start, wk1End)) { appt7++; apptList.push({apptDate, bookedDate, name: a.contact_name}) }
  if (bookedDate && inWindow(bookedDate, wk1Start, wk1End)) { booked7++; bookedList.push({apptDate, bookedDate, name: a.contact_name}) }
}

console.log(`Window: ${wk1Start} to ${wk1End}\n`)
console.log(`STRATEGY appointments where APPOINTMENT happens this week (by appt_date) = ${appt7}`)
for (const r of apptList) console.log(`  appt=${r.apptDate}  booked=${r.bookedDate}  "${r.name}"`)
console.log(`\nSTRATEGY appointments BOOKED this week (by booked_at) = ${booked7}`)
for (const r of bookedList) console.log(`  appt=${r.apptDate}  booked=${r.bookedDate}  "${r.name}"`)

// Leads in this window (always by createdAt, fixed semantics)
const { data: mt } = await supabase.from('marketing_tracker').select('date, leads, qualified_bookings').gte('date', wk1Start).lte('date', wk1End).order('date')
let leads = 0, qb = 0
for (const r of mt || []) { leads += r.leads || 0; qb += r.qualified_bookings || 0 }
console.log(`\nMarketing tracker rows (Apr 28 - May 4):  leads=${leads}  qualified_bookings=${qb}`)
