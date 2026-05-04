// Force-rebuild qualified_bookings + auto_bookings in marketing_tracker for the
// last 30 days from ghl_appointments using the FULL 8-calendar STRATEGY list
// (including the two Calendly mirrors). This replicates exactly what
// syncMetaToTracker would do — but driven from Node so we don't depend on
// the user's browser running fresh code.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

const STRATEGY = [
  '9yoQVPBkNX4tWYmcDkf3', 'cEyqCFAsPLDkUV8n982h', 'HDsTrgpsFOXw9V4AkZGq',
  'aQsmGwANALCwJBI7G9vT', 'StLqrES6WMO8f3Obdu9d', '3mLE6t6rCKDdIuIfvP9j',
  'T5Zif5GjDwulya6novU0', 'gohFzPCilzwBtVfaC6fu',
]
const INTRO = ['5omixNmtgmGMWQfEL0fs', 'C5NRRAjwsy43nOyU6izQ', 'GpYh75LaFEJgpHYkZfN9', 'okWMyvLhnJ7sbuvSIzok', 'MvYStrHFsRTpunwTXIqT']

const since = (() => { const s = new Date(); s.setDate(s.getDate() - 30); return s.toISOString().split('T')[0] })()
const until = new Date().toISOString().split('T')[0]
console.log(`Window: ${since} → ${until}`)

// Strategy → qualified_bookings (bucketed by appointment_date)
const { data: strat } = await supabase
  .from('ghl_appointments')
  .select('appointment_date, calendar_name')
  .gte('appointment_date', since)
  .lte('appointment_date', until)
  .neq('appointment_status', 'cancelled')
  .in('calendar_name', STRATEGY)

const qualByDate = {}
for (const a of strat || []) {
  const d = a.appointment_date
  if (!d) continue
  qualByDate[d] = (qualByDate[d] || 0) + 1
}
console.log(`\nStrategy events: ${strat?.length || 0} → ${Object.keys(qualByDate).length} dates`)

// Intro → auto_bookings (bucketed by booked_at, fallback to appointment_date)
const { data: intro } = await supabase
  .from('ghl_appointments')
  .select('booked_at, appointment_date, calendar_name')
  .or(`booked_at.gte.${since},appointment_date.gte.${since}`)
  .neq('appointment_status', 'cancelled')
  .in('calendar_name', INTRO)

const autoByDate = {}
for (const a of intro || []) {
  const raw = a.booked_at || a.appointment_date
  if (!raw) continue
  const d = String(raw).split(' ')[0].split('T')[0]
  if (d < since || d > until) continue
  autoByDate[d] = (autoByDate[d] || 0) + 1
}
console.log(`Intro events: ${intro?.length || 0} → ${Object.keys(autoByDate).length} dates`)

// Build all dates set, fetch existing rows, patch
const allDates = [...new Set([...Object.keys(qualByDate), ...Object.keys(autoByDate)])]
const { data: existingRows } = await supabase
  .from('marketing_tracker')
  .select('date')
  .in('date', allDates)
const existingSet = new Set((existingRows || []).map(r => r.date))

let patched = 0, inserted = 0
console.log(`\n=== Per-date plan ===`)
for (const date of allDates.sort()) {
  const q = qualByDate[date] || 0
  const a = autoByDate[date] || 0
  console.log(`  ${date}  Q.BOOK=${q}  AUTO=${a}  ${existingSet.has(date) ? 'patch' : 'insert'}`)
  if (existingSet.has(date)) {
    const { error } = await supabase
      .from('marketing_tracker')
      .update({ qualified_bookings: q, auto_bookings: a, updated_at: new Date().toISOString() })
      .eq('date', date)
    if (error) { console.error(`  ! ${date}: ${error.message}`); continue }
    patched++
  } else {
    const { error } = await supabase
      .from('marketing_tracker')
      .insert({ date, qualified_bookings: q, auto_bookings: a, updated_at: new Date().toISOString() })
    if (error) { console.error(`  ! ${date}: ${error.message}`); continue }
    inserted++
  }
}

console.log(`\nPatched ${patched} rows, inserted ${inserted}`)
