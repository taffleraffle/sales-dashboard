import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

console.log('Today: 2026-05-06\n')

// Mimic sinceDate(1) — returns today minus 1 day (yesterday). The hook then
// fetches `report_date >= yesterday`, which captures BOTH yesterday AND today.
const since = new Date('2026-05-06')
since.setDate(since.getDate() - 1)
const sinceStr = since.toISOString().slice(0, 10)
console.log(`sinceDate(1) returns: ${sinceStr}`)
console.log(`Hook will fetch report_date >= ${sinceStr} → returns yesterday + today\n`)

const { data: reports } = await sb.from('closer_eod_reports')
  .select('report_date, closer:team_members(name), nc_booked, fu_booked, live_nc_calls, live_fu_calls, nc_no_shows, fu_no_shows, offers, closes, reschedules, total_revenue, total_cash_collected, is_confirmed')
  .gte('report_date', sinceStr)
  .order('report_date')

console.log(`Reports returned with days=1 filter:`)
for (const r of reports || []) {
  console.log(`  ${r.report_date} | ${r.closer?.name} | confirmed=${r.is_confirmed} | nc_booked=${r.nc_booked} liveNC=${r.live_nc_calls} fu_booked=${r.fu_booked} liveFU=${r.live_fu_calls} ns=${(r.nc_no_shows||0)+(r.fu_no_shows||0)} resch=${r.reschedules} offers=${r.offers} closes=${r.closes}`)
}

// Aggregate as the dashboard does
const ct = (reports || []).reduce((a, r) => ({
  booked: a.booked + (r.nc_booked || 0) + (r.fu_booked || 0),
  ncBooked: a.ncBooked + (r.nc_booked || 0),
  liveCalls: a.liveCalls + (r.live_nc_calls || 0) + (r.live_fu_calls || 0),
  liveNC: a.liveNC + (r.live_nc_calls || 0),
  offers: a.offers + (r.offers || 0),
  closes: a.closes + (r.closes || 0),
}), { booked: 0, ncBooked: 0, liveCalls: 0, liveNC: 0, offers: 0, closes: 0 })

console.log(`\nDashboard aggregation:`)
console.log(`  booked = ${ct.booked} (NC ${ct.ncBooked} + FU)`)
console.log(`  live calls = ${ct.liveCalls} (NC ${ct.liveNC} + FU)`)
console.log(`  show rate = liveNC / ncBooked = ${ct.liveNC}/${ct.ncBooked} = ${ct.ncBooked ? (ct.liveNC/ct.ncBooked*100).toFixed(1) : 0}%`)
console.log(`  offer rate = offers / liveCalls = ${ct.offers}/${ct.liveCalls} = ${ct.liveCalls ? (ct.offers/ct.liveCalls*100).toFixed(1) : 0}%`)
console.log()

// What today-only would actually look like
const today = (reports || []).filter(r => r.report_date === '2026-05-06')
console.log(`Reports for ${'2026-05-06'} (today, what user expects):`)
console.log(`  ${today.length === 0 ? '(no EOD filed yet)' : JSON.stringify(today, null, 2)}`)
