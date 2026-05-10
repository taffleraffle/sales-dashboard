import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

// 5/5 EOD with calls
const { data: r } = await sb.from('closer_eod_reports')
  .select('id, report_date, nc_booked, fu_booked, live_nc_calls, live_fu_calls, nc_no_shows, fu_no_shows, offers, closes, reschedules, total_revenue, total_cash_collected, ascend_revenue, ascend_cash, deposits, is_confirmed')
  .eq('report_date', '2026-05-05')
console.log('5/5 EOD:', JSON.stringify(r, null, 2))

const ids = (r || []).map(x => x.id)
const { data: calls } = await sb.from('closer_calls')
  .select('prospect_name, call_type, outcome, revenue, cash_collected')
  .in('eod_report_id', ids)
console.log('\n5/5 calls:')
for (const c of calls || []) console.log(`  ${c.call_type} | ${c.outcome} | ${c.prospect_name} | rev=${c.revenue} cash=${c.cash_collected}`)

// 7d default - show what 7d shows
console.log('\n--- 7d window check ---')
const { data: r7 } = await sb.from('closer_eod_reports')
  .select('report_date, nc_booked, fu_booked, live_nc_calls, live_fu_calls, offers, closes, total_revenue, total_cash_collected')
  .gte('report_date', '2026-04-29')
  .order('report_date')
let agg = { ncb:0, fub:0, lnc:0, lfu:0, off:0, cl:0, rev:0, cash:0 }
for (const x of r7) {
  agg.ncb += x.nc_booked||0; agg.fub += x.fu_booked||0
  agg.lnc += x.live_nc_calls||0; agg.lfu += x.live_fu_calls||0
  agg.off += x.offers||0; agg.cl += x.closes||0
  agg.rev += parseFloat(x.total_revenue||0); agg.cash += parseFloat(x.total_cash_collected||0)
}
console.log(`7d (4/29 - 5/6): ncBooked=${agg.ncb} fuBooked=${agg.fub} liveNC=${agg.lnc} liveFU=${agg.lfu} offers=${agg.off} closes=${agg.cl} rev=${agg.rev} cash=${agg.cash}`)
console.log(`  Show rate (liveNC/ncBooked) = ${agg.lnc}/${agg.ncb} = ${(agg.lnc/agg.ncb*100).toFixed(1)}%`)
console.log(`  Offer rate (offers/liveCalls) = ${agg.off}/${agg.lnc+agg.lfu} = ${(agg.off/(agg.lnc+agg.lfu)*100).toFixed(1)}%`)
