// List every no-show closer_calls row in the trailing 7 days, with the
// closer who logged it and the date.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

const from7d = '2026-04-28', to7d = '2026-05-04'

// Get all confirmed closer EOD reports in window
const { data: reports } = await supabase
  .from('closer_eod_reports')
  .select('id, closer_id, report_date, nc_no_shows, fu_no_shows, closer:team_members!closer_eod_reports_closer_id_fkey(name)')
  .gte('report_date', from7d)
  .lte('report_date', to7d)
  .eq('is_confirmed', true)

console.log(`\n=== Closer EOD reports (${from7d} → ${to7d}) ===\n`)
let totalEodNoShows = 0
for (const r of reports || []) {
  const ns = (r.nc_no_shows || 0) + (r.fu_no_shows || 0)
  totalEodNoShows += ns
  console.log(`  ${r.report_date}  ${r.closer?.name || r.closer_id.slice(0,8)}  nc_no_shows=${r.nc_no_shows || 0}  fu_no_shows=${r.fu_no_shows || 0}  total=${ns}`)
}
console.log(`\nEOD-aggregated no-shows: ${totalEodNoShows}`)

// Now list each closer_calls row with outcome=no_show in the window
const reportIds = (reports || []).map(r => r.id)
if (reportIds.length === 0) { console.log('No reports — done.'); process.exit(0) }

const { data: calls } = await supabase
  .from('closer_calls')
  .select('eod_report_id, prospect_name, call_type, outcome, notes, ghl_event_id, eod:closer_eod_reports!closer_calls_eod_report_id_fkey(report_date, closer_id, closer:team_members!closer_eod_reports_closer_id_fkey(name))')
  .in('eod_report_id', reportIds)
  .eq('outcome', 'no_show')

console.log(`\n=== Individual no-show closer_calls rows ===\n`)
console.log(`date         closer       call_type    prospect`)
console.log(`-----------  -----------  -----------  ----------------------------------------`)
for (const c of (calls || []).sort((a,b) => (a.eod?.report_date || '').localeCompare(b.eod?.report_date || ''))) {
  console.log(`${(c.eod?.report_date || '').padEnd(11)}  ${(c.eod?.closer?.name || '').padEnd(11)}  ${(c.call_type || '').padEnd(11)}  ${c.prospect_name || '(no name)'}`)
}
console.log(`\nTotal individual no-show rows: ${(calls || []).length}`)

// Marketing tracker no_shows
const { data: mt } = await supabase
  .from('marketing_tracker')
  .select('date, no_shows')
  .gte('date', from7d)
  .lte('date', to7d)
const mtTotal = (mt || []).reduce((s, r) => s + (r.no_shows || 0), 0)
console.log(`\nmarketing_tracker.no_shows total in window: ${mtTotal}`)
