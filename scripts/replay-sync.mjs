// Replay the qualified_bookings + auto_bookings query EXACTLY as syncMetaToTracker does it.
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

const trackerSince = (() => { const s = new Date(); s.setDate(s.getDate() - 30); return s.toISOString().split('T')[0] })()
const trackerUntil = new Date().toISOString().split('T')[0]

console.log(`trackerSince=${trackerSince}  trackerUntil=${trackerUntil}\n`)

// Strategy
{
  const { data, error } = await supabase
    .from('ghl_appointments')
    .select('appointment_date, calendar_name, ghl_contact_id, appointment_status')
    .gte('appointment_date', trackerSince)
    .lte('appointment_date', trackerUntil)
    .neq('appointment_status', 'cancelled')
    .in('calendar_name', STRATEGY)
    .order('appointment_date', { ascending: true })
  if (error) { console.error('Strategy query error:', error); process.exit(1) }
  console.log(`STRATEGY query returned ${data.length} rows`)
  const byDate = {}
  for (const r of data) byDate[r.appointment_date] = (byDate[r.appointment_date] || 0) + 1
  for (const [d, c] of Object.entries(byDate).sort()) console.log(`  ${d}: ${c}`)
}

// Intro
console.log()
{
  const { data, error } = await supabase
    .from('ghl_appointments')
    .select('appointment_date, calendar_name')
    .or(`booked_at.gte.${trackerSince},appointment_date.gte.${trackerSince}`)
    .neq('appointment_status', 'cancelled')
    .in('calendar_name', INTRO)
  if (error) { console.error('Intro query error:', error); process.exit(1) }
  console.log(`INTRO query returned ${data.length} rows`)
}

// Verify constants in deployed bundle by hashing
console.log()
console.log('Local constants list (8 strategy):')
for (const id of STRATEGY) console.log(`  ${id}`)
