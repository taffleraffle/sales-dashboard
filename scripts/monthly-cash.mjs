// Monthly spend + cash breakdown from marketing_tracker
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const idx = l.indexOf('=')
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()]
    })
)
const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_ANON = env.VITE_SUPABASE_ANON_KEY

const FROM = '2026-01-01'
const TO = '2026-04-30'

const url = `${SUPABASE_URL}/rest/v1/marketing_tracker?select=date,adspend,leads,qualified_bookings,trial_cash,trial_revenue,ascend_cash,ascend_revenue,ar_collected,ar_defaulted,refund_amount,closes,ascensions&date=gte.${FROM}&date=lte.${TO}&order=date.asc`

const res = await fetch(url, {
  headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` },
})
if (!res.ok) {
  console.error('Supabase error:', res.status, await res.text())
  process.exit(1)
}
const rows = await res.json()

const months = {}
const monthName = m => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]

for (const r of rows) {
  const m = r.date.slice(0, 7) // YYYY-MM
  if (!months[m]) months[m] = {
    days: 0, adspend: 0, trial: 0, ascend: 0, ar: 0, ar_def: 0, refund: 0,
    leads: 0, qb: 0, closes: 0, asc: 0, trial_rev: 0, ascend_rev: 0,
  }
  const x = months[m]
  x.days++
  x.adspend += Number(r.adspend || 0)
  x.trial += Number(r.trial_cash || 0)
  x.ascend += Number(r.ascend_cash || 0)
  x.ar += Number(r.ar_collected || 0)
  x.ar_def += Number(r.ar_defaulted || 0)
  x.refund += Number(r.refund_amount || 0)
  x.leads += r.leads || 0
  x.qb += r.qualified_bookings || 0
  x.closes += r.closes || 0
  x.asc += r.ascensions || 0
  x.trial_rev += Number(r.trial_revenue || 0)
  x.ascend_rev += Number(r.ascend_revenue || 0)
}

const fmt = n => '$' + n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const pad = (s, w) => String(s).padStart(w)

console.log('\n=== MONTHLY SPEND vs. CASH (marketing_tracker) ===\n')
console.log('Month     Days  Ad Spend    Trial $    Ascend $    AR $       TOTAL CASH    Cash ROAS  Revenue $    Rev ROAS  Leads  Closes  Asc')
console.log('-------   ----  ---------   --------   ---------   --------   ----------    ---------  ----------   --------  -----  ------  ----')

const allMonths = ['2026-01', '2026-02', '2026-03', '2026-04']
const totals = { days: 0, adspend: 0, trial: 0, ascend: 0, ar: 0, leads: 0, qb: 0, closes: 0, asc: 0, trial_rev: 0, ascend_rev: 0 }

for (const m of allMonths) {
  const x = months[m] || { days: 0, adspend: 0, trial: 0, ascend: 0, ar: 0, leads: 0, qb: 0, closes: 0, asc: 0, trial_rev: 0, ascend_rev: 0 }
  const totalCash = x.trial + x.ascend + x.ar
  const totalRev = x.trial_rev + x.ascend_rev
  const cashRoas = x.adspend > 0 ? totalCash / x.adspend : 0
  const revRoas = x.adspend > 0 ? totalRev / x.adspend : 0
  console.log(
    `${monthName(Number(m.slice(5)))} 2026   ${pad(x.days, 4)}  ${pad(fmt(x.adspend), 9)}   ${pad(fmt(x.trial), 8)}   ${pad(fmt(x.ascend), 9)}   ${pad(fmt(x.ar), 8)}   ${pad(fmt(totalCash), 10)}    ${pad(cashRoas.toFixed(2) + 'x', 9)}  ${pad(fmt(totalRev), 10)}   ${pad(revRoas.toFixed(2) + 'x', 8)}  ${pad(x.leads, 5)}  ${pad(x.closes, 6)}  ${pad(x.asc, 4)}`
  )
  totals.days += x.days
  totals.adspend += x.adspend
  totals.trial += x.trial
  totals.ascend += x.ascend
  totals.ar += x.ar
  totals.leads += x.leads
  totals.qb += x.qb
  totals.closes += x.closes
  totals.asc += x.asc
  totals.trial_rev += x.trial_rev
  totals.ascend_rev += x.ascend_rev
}

console.log('-------   ----  ---------   --------   ---------   --------   ----------    ---------  ----------   --------  -----  ------  ----')
const totalCash = totals.trial + totals.ascend + totals.ar
const totalRev = totals.trial_rev + totals.ascend_rev
console.log(
  `YTD       ${pad(totals.days, 4)}  ${pad(fmt(totals.adspend), 9)}   ${pad(fmt(totals.trial), 8)}   ${pad(fmt(totals.ascend), 9)}   ${pad(fmt(totals.ar), 8)}   ${pad(fmt(totalCash), 10)}    ${pad((totals.adspend > 0 ? totalCash / totals.adspend : 0).toFixed(2) + 'x', 9)}  ${pad(fmt(totalRev), 10)}   ${pad((totals.adspend > 0 ? totalRev / totals.adspend : 0).toFixed(2) + 'x', 8)}  ${pad(totals.leads, 5)}  ${pad(totals.closes, 6)}  ${pad(totals.asc, 4)}`
)
console.log('')
