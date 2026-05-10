import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

const { data: reports } = await sb.from('closer_eod_reports').select('id, report_date').gte('report_date', '2026-04-09').lte('report_date', '2026-04-22').eq('is_confirmed', true)
const ids = reports.map(r => r.id)
const reportDate = Object.fromEntries(reports.map(r => [r.id, r.report_date]))
const { data: calls } = await sb.from('closer_calls').select('prospect_name, call_type, outcome, revenue, cash_collected, eod_report_id').in('eod_report_id', ids)

console.log('=== Closes/ascensions Apr 9 → Apr 22 ===')
for (const c of calls.filter(c => ['closed','ascended'].includes(c.outcome)).sort((a,b) => reportDate[a.eod_report_id].localeCompare(reportDate[b.eod_report_id]))) {
  console.log(`  ${reportDate[c.eod_report_id]} | ${c.call_type.padEnd(10)} | ${c.outcome.padEnd(9)} | ${c.prospect_name} | $${c.revenue} rev / $${c.cash_collected} cash`)
}
