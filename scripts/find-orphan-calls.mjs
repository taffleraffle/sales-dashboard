// Look for closer_calls rows that match the date range — orphaned, attached
// to other reports, or anywhere else they might live.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

// Pull ALL closer_calls — any time, any closer
const { data: allCalls, count: allCount } = await supabase
  .from('closer_calls')
  .select('id, prospect_name, outcome, eod_report_id, created_at, ghl_event_id, call_type', { count: 'exact' })
  .order('created_at', { ascending: false })
  .limit(50)

console.log(`Total closer_calls rows in DB: ${allCount}`)
console.log(`\nMost recent 50:\n`)
for (const c of allCalls || []) {
  console.log(`  ${c.created_at?.slice(0, 19)}  outcome=${(c.outcome || '(null)').padEnd(12)}  type=${c.call_type}  eod=${c.eod_report_id?.slice(0,8) || '(none)'}  "${c.prospect_name}"`)
}

// And EOD reports for Daniel in 7d
const { data: reports } = await supabase
  .from('closer_eod_reports')
  .select('id, report_date, is_confirmed, created_at')
  .gte('report_date', '2026-04-28')
  .lte('report_date', '2026-05-04')
  .order('report_date', { ascending: true })

console.log(`\n=== Closer EOD reports in 7d window ===`)
for (const r of reports || []) {
  console.log(`  ${r.report_date}  id=${r.id.slice(0,8)}  confirmed=${r.is_confirmed}  created=${r.created_at?.slice(0,19)}`)
}
