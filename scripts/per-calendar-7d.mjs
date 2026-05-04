// Show every strategy-calendar booking in the last 7 days, broken out by
// which calendar it landed on. Plus the trailing-30d picture for comparison.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

const STRAT = {
  '9yoQVPBkNX4tWYmcDkf3': 'Remodeling AI - Strategy Call',
  'cEyqCFAsPLDkUV8n982h': 'RestorationConnect AI - Strategy Call',
  'HDsTrgpsFOXw9V4AkZGq': '(FB) RestorationConnect AI - Strategy Call',
  'aQsmGwANALCwJBI7G9vT': 'PlumberConnect AI - Strategy Call',
  'StLqrES6WMO8f3Obdu9d': 'PoolConnect AI - Strategy Call',
  '3mLE6t6rCKDdIuIfvP9j': '(FB) PoolConnectAI - Strategy Call',
  'T5Zif5GjDwulya6novU0': 'Opt Digital | Strategy Call (Calendly)',
  'gohFzPCilzwBtVfaC6fu': 'Opt Digital | Strategy Call - DQ (Calendly)',
}

// 7d in NZ time = today_NZ - 7 to today_NZ
// Use 2026-04-28 to 2026-05-04 (matches what page shows for trailing 7d)
const from7d = '2026-04-28', to7d = '2026-05-04'
const from30d = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().split('T')[0] })()

const { data: rows } = await supabase
  .from('ghl_appointments')
  .select('calendar_name, contact_name, appointment_date, booked_at, appointment_status')
  .in('calendar_name', Object.keys(STRAT))
  .neq('appointment_status', 'cancelled')

const bucket = (raw) => raw ? String(raw).split(' ')[0].split('T')[0] : null
const counts7 = {}, counts30 = {}, names7 = {}
for (const r of rows || []) {
  const d = bucket(r.booked_at) || r.appointment_date
  if (!d) continue
  if (d >= from7d && d <= to7d) {
    counts7[r.calendar_name] = (counts7[r.calendar_name] || 0) + 1
    if (!names7[r.calendar_name]) names7[r.calendar_name] = []
    names7[r.calendar_name].push(`${d}  "${r.contact_name}"`)
  }
  if (d >= from30d) counts30[r.calendar_name] = (counts30[r.calendar_name] || 0) + 1
}

console.log(`\n=== TRAILING 7d (${from7d} → ${to7d}) bucketed by booked_at ===\n`)
let total7 = 0
for (const id of Object.keys(STRAT)) {
  const c = counts7[id] || 0
  total7 += c
  if (c > 0) {
    console.log(`  ${c.toString().padStart(2)}  ${STRAT[id].padEnd(48)} (${id})`)
    for (const n of names7[id]) console.log(`        ${n}`)
  } else {
    console.log(`   0  ${STRAT[id]}`)
  }
}
console.log(`\n  TOTAL 7d: ${total7}`)

console.log(`\n=== TRAILING 30d (${from30d} → today) by calendar ===\n`)
let total30 = 0
for (const id of Object.keys(STRAT)) {
  const c = counts30[id] || 0
  total30 += c
  console.log(`  ${c.toString().padStart(3)}  ${STRAT[id]}`)
}
console.log(`\n  TOTAL 30d: ${total30}`)
