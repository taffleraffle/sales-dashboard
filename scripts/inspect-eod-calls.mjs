// Pull every closer_calls row attached to the recent confirmed EODs
// regardless of outcome — find out what the data actually looks like.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

const from7d = '2026-04-28', to7d = '2026-05-04'
const { data: reports } = await supabase
  .from('closer_eod_reports')
  .select('id, report_date, nc_no_shows, fu_no_shows, nc_booked, fu_booked, live_nc_calls, live_fu_calls')
  .gte('report_date', from7d).lte('report_date', to7d).eq('is_confirmed', true)

for (const r of reports || []) {
  console.log(`\n=== ${r.report_date}  (booked=${r.nc_booked + r.fu_booked}, live=${r.live_nc_calls + r.live_fu_calls}, no_shows=${r.nc_no_shows + r.fu_no_shows}) ===`)
  const { data: calls } = await supabase
    .from('closer_calls')
    .select('prospect_name, call_type, outcome, ghl_event_id')
    .eq('eod_report_id', r.id)
    .order('id')
  console.log(`  closer_calls rows: ${(calls || []).length}`)
  for (const c of calls || []) {
    console.log(`    type=${c.call_type}  outcome=${c.outcome || '(null)'}  prospect="${c.prospect_name}"  evt=${c.ghl_event_id?.slice(0, 8) || '-'}`)
  }
}
