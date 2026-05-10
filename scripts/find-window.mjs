import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

// All EOD reports from all closers, last 30 days
const { data: reports } = await sb.from('closer_eod_reports')
  .select('report_date, closer_id, closer:team_members(name), nc_booked, fu_booked, live_nc_calls, live_fu_calls, offers, closes, reschedules, total_revenue, total_cash_collected, is_confirmed')
  .gte('report_date', '2026-04-01')
  .order('report_date')
console.log('All EOD reports since Apr 1:')
for (const r of reports || []) {
  console.log(`  ${r.report_date} | ${r.closer?.name?.padEnd(8)} | conf=${r.is_confirmed} | ncB=${r.nc_booked} fuB=${r.fu_booked} liveNC=${r.live_nc_calls} liveFU=${r.live_fu_calls} off=${r.offers} cl=${r.closes} rev=${r.total_revenue}`)
}
console.log()

// Find which date window gives ncBooked=13 and liveNC=4
console.log('=== Searching for combo matching dashboard (ncBooked=13, liveNC=4) ===')
for (let days = 1; days <= 14; days++) {
  const since = new Date('2026-05-06'); since.setDate(since.getDate() - days)
  const sinceStr = since.toISOString().slice(0,10)
  const filtered = (reports || []).filter(r => r.report_date >= sinceStr)
  const ncB = filtered.reduce((s,r) => s + (r.nc_booked||0), 0)
  const liveNC = filtered.reduce((s,r) => s + (r.live_nc_calls||0), 0)
  const cl = filtered.reduce((s,r) => s + (r.closes||0), 0)
  const off = filtered.reduce((s,r) => s + (r.offers||0), 0)
  const liveCalls = filtered.reduce((s,r) => s + (r.live_nc_calls||0) + (r.live_fu_calls||0), 0)
  const rev = filtered.reduce((s,r) => s + parseFloat(r.total_revenue||0), 0)
  console.log(`  days=${days} (since ${sinceStr}): ncB=${ncB} liveNC=${liveNC} liveCalls=${liveCalls} closes=${cl} offers=${off} rev=${rev}${ncB === 13 && liveNC === 4 ? '  ← MATCH' : ''}`)
}
