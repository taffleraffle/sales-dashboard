import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] })
)
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

// Current 14d window
const { data: reports } = await sb.from('closer_eod_reports')
  .select('id, report_date, live_nc_calls, live_fu_calls, offers, closes, deposits, total_revenue, total_cash_collected, ascend_revenue, ascend_cash, notes')
  .gte('report_date', '2026-04-23')
  .lte('report_date', '2026-05-06')
  .eq('is_confirmed', true)
  .order('report_date')

console.log('=== Daniel\'s last 14 days, day by day ===\n')
for (const r of reports || []) {
  console.log(`${r.report_date} | live_nc=${r.live_nc_calls} live_fu=${r.live_fu_calls} offers=${r.offers} closes=${r.closes} dep=${r.deposits} | $${r.total_revenue || 0} contracted | $${r.total_cash_collected || 0} cash | asc rev $${r.ascend_revenue || 0}${r.notes ? ` | "${r.notes}"` : ''}`)
}

// Per-call detail for current 14d
const ids = (reports || []).map(r => r.id)
const { data: calls } = await sb.from('closer_calls')
  .select('prospect_name, call_type, outcome, revenue, cash_collected, offered_finance, eod_report_id')
  .in('eod_report_id', ids)
const reportDate = Object.fromEntries((reports || []).map(r => [r.id, r.report_date]))

console.log('\n=== Every individual call in the last 14d ===\n')
const sorted = (calls || []).sort((a, b) => (reportDate[a.eod_report_id] || '').localeCompare(reportDate[b.eod_report_id] || ''))
for (const c of sorted) {
  const live = !['no_show','rescheduled','canceled'].includes(c.outcome)
  console.log(`${reportDate[c.eod_report_id]} | ${c.call_type.padEnd(10)} | ${c.outcome.padEnd(11)} | ${live ? 'LIVE' : 'no  '} | ${c.prospect_name} ${c.revenue ? `($${c.revenue})` : ''}`)
}

// Aggregate by outcome
const byOutcome = {}
for (const c of calls || []) byOutcome[c.outcome] = (byOutcome[c.outcome] || 0) + 1
console.log('\n=== Outcomes (last 14d) ===')
for (const [k, v] of Object.entries(byOutcome).sort((a,b) => b[1]-a[1])) console.log(`  ${k}: ${v}`)

// Compare to prior 14d
console.log('\n=== Prior 14d (Apr 9 → Apr 22) for comparison ===\n')
const { data: priorReports } = await sb.from('closer_eod_reports')
  .select('id')
  .gte('report_date', '2026-04-09')
  .lte('report_date', '2026-04-22')
  .eq('is_confirmed', true)
const priorIds = (priorReports || []).map(r => r.id)
const { data: priorCalls } = await sb.from('closer_calls')
  .select('prospect_name, call_type, outcome, revenue, cash_collected, eod_report_id')
  .in('eod_report_id', priorIds)
const priorByOutcome = {}
for (const c of priorCalls || []) priorByOutcome[c.outcome] = (priorByOutcome[c.outcome] || 0) + 1
console.log('Prior outcomes:')
for (const [k, v] of Object.entries(priorByOutcome).sort((a,b) => b[1]-a[1])) console.log(`  ${k}: ${v}`)
console.log('\nPrior closed/ascended calls:')
for (const c of priorCalls || []) {
  if (['closed','ascended'].includes(c.outcome)) console.log(`  ${c.prospect_name} | ${c.call_type} | ${c.outcome} | $${c.revenue || 0} rev / $${c.cash_collected || 0} cash`)
}
