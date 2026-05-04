// Diagnose why marketing tracker shows fewer live calls / qualified bookings
// than the EOD dashboard. Look at all three sources for today + recent days
// and find the discrepancy.

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

const days = []
for (let i = 0; i < 7; i++) {
  const d = new Date()
  d.setDate(d.getDate() - i)
  days.push(d.toISOString().split('T')[0])
}
days.reverse()

console.log(`\n=== marketing_tracker rows for last 7d ===`)
const { data: mt } = await supabase
  .from('marketing_tracker')
  .select('date, qualified_bookings, auto_bookings, live_calls, new_live_calls, no_shows, closes, updated_at')
  .in('date', days)
  .order('date')
for (const r of mt || []) {
  console.log(`  ${r.date}  Q.BOOK=${r.qualified_bookings ?? '—'}  AUTO=${r.auto_bookings ?? '—'}  LIVE=${r.live_calls ?? '—'}  NEW_LIVE=${r.new_live_calls ?? '—'}  NS=${r.no_shows ?? '—'}  CL=${r.closes ?? '—'}  upd=${r.updated_at?.slice(0, 19)}`)
}

console.log(`\n=== closer_eod_reports + counted closer_calls per day ===`)
for (const day of days) {
  const { data: reports } = await supabase
    .from('closer_eod_reports')
    .select('id, closer_id, is_confirmed, nc_booked, fu_booked, live_nc_calls, live_fu_calls, nc_no_shows, closes')
    .eq('report_date', day)
  if (!reports?.length) { console.log(`  ${day}  (no reports)`); continue }
  let totBooked = 0, totLive = 0, totLiveNc = 0, totNoShow = 0, totCloses = 0, confirmed = 0
  for (const r of reports) {
    if (r.is_confirmed) confirmed++
    totBooked += (r.nc_booked || 0) + (r.fu_booked || 0)
    totLive += (r.live_nc_calls || 0) + (r.live_fu_calls || 0)
    totLiveNc += (r.live_nc_calls || 0)
    totNoShow += (r.nc_no_shows || 0)
    totCloses += (r.closes || 0)
  }
  console.log(`  ${day}  ${confirmed}/${reports.length} confirmed  BOOKED=${totBooked}  LIVE=${totLive}  NEW_LIVE=${totLiveNc}  NS=${totNoShow}  CL=${totCloses}`)
}

console.log(`\n=== ghl_appointments STRATEGY-only per day (raw count, not deduped) ===`)
for (const day of days) {
  const { count } = await supabase
    .from('ghl_appointments')
    .select('*', { count: 'exact', head: true })
    .eq('appointment_date', day)
    .neq('appointment_status', 'cancelled')
    .in('calendar_name', STRATEGY)
  console.log(`  ${day}  strategy_appts=${count}`)
}

console.log(`\n=== closer_calls per confirmed report — null outcomes, missing event ids ===`)
for (const day of days.slice(-3)) {
  const { data: reports } = await supabase
    .from('closer_eod_reports')
    .select('id, closer_id, is_confirmed')
    .eq('report_date', day)
    .eq('is_confirmed', true)
  if (!reports?.length) continue
  for (const r of reports) {
    const { data: calls } = await supabase
      .from('closer_calls')
      .select('outcome, ghl_event_id')
      .eq('eod_report_id', r.id)
    const total = (calls || []).length
    const nulls = (calls || []).filter(c => c.outcome == null).length
    const missingEvt = (calls || []).filter(c => !c.ghl_event_id).length
    console.log(`  ${day}  closer=${r.closer_id.slice(0, 8)}  total=${total}  null_outcome=${nulls}  missing_ghl_event_id=${missingEvt}`)
  }
}
