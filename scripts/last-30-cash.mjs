// Last-30-day spend + total cash from marketing_tracker
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

// Today (server) → 30 days back, inclusive
const today = new Date()
const todayStr = today.toISOString().split('T')[0]
const since = new Date(today)
since.setDate(since.getDate() - 29) // inclusive: last 30 days
const sinceStr = since.toISOString().split('T')[0]

const url = `${SUPABASE_URL}/rest/v1/marketing_tracker?select=date,adspend,leads,qualified_bookings,trial_cash,trial_revenue,ascend_cash,ascend_revenue,ar_collected,ar_defaulted,refund_amount,closes,ascensions&date=gte.${sinceStr}&date=lte.${todayStr}&order=date.desc`

const res = await fetch(url, {
  headers: {
    apikey: SUPABASE_ANON,
    Authorization: `Bearer ${SUPABASE_ANON}`,
  },
})
if (!res.ok) {
  console.error('Supabase error:', res.status, await res.text())
  process.exit(1)
}
const rows = await res.json()

console.log(`\n=== marketing_tracker — ${sinceStr} → ${todayStr} (${rows.length} rows) ===\n`)
console.log('date         adspend     trial$    ascend$   ar$       total$    leads  closes  asc')
console.log('----------   --------    --------  --------  --------  --------  -----  ------  ----')
let t = { adspend: 0, trial: 0, ascend: 0, ar: 0, ar_def: 0, refund: 0, leads: 0, qb: 0, closes: 0, asc: 0, trial_rev: 0, ascend_rev: 0 }
for (const r of rows.sort((a,b) => a.date.localeCompare(b.date))) {
  const ads = Number(r.adspend || 0)
  const tc = Number(r.trial_cash || 0)
  const ac = Number(r.ascend_cash || 0)
  const ar = Number(r.ar_collected || 0)
  const total = tc + ac + ar
  t.adspend += ads
  t.trial += tc
  t.ascend += ac
  t.ar += ar
  t.ar_def += Number(r.ar_defaulted || 0)
  t.refund += Number(r.refund_amount || 0)
  t.leads += r.leads || 0
  t.qb += r.qualified_bookings || 0
  t.closes += r.closes || 0
  t.asc += r.ascensions || 0
  t.trial_rev += Number(r.trial_revenue || 0)
  t.ascend_rev += Number(r.ascend_revenue || 0)
  console.log(
    `${r.date}   $${ads.toFixed(0).padStart(7)}    $${tc.toFixed(0).padStart(7)}  $${ac.toFixed(0).padStart(7)}  $${ar.toFixed(0).padStart(7)}  $${total.toFixed(0).padStart(7)}  ${String(r.leads || 0).padStart(5)}  ${String(r.closes || 0).padStart(6)}  ${String(r.ascensions || 0).padStart(4)}`
  )
}

const totalCash = t.trial + t.ascend + t.ar
console.log('\n=== TOTALS (last 30 days) ===')
console.log(`Period:           ${sinceStr} → ${todayStr}  (${rows.length} days with data)`)
console.log(`Ad spend:         $${t.adspend.toFixed(2)}`)
console.log(`Trial cash:       $${t.trial.toFixed(2)}`)
console.log(`Ascension cash:   $${t.ascend.toFixed(2)}`)
console.log(`AR collected:     $${t.ar.toFixed(2)}`)
console.log(`AR defaulted:     $${t.ar_def.toFixed(2)}`)
console.log(`Refunds:          $${t.refund.toFixed(2)}`)
console.log(`-----`)
console.log(`TOTAL CASH ROW:   $${totalCash.toFixed(2)}   (trial + ascend + AR)`)
console.log(`Trial revenue:    $${t.trial_rev.toFixed(2)}`)
console.log(`Ascend revenue:   $${t.ascend_rev.toFixed(2)}`)
console.log(`Total revenue:    $${(t.trial_rev + t.ascend_rev).toFixed(2)}`)
console.log(`-----`)
console.log(`ROAS (cash/spend):    ${t.adspend > 0 ? (totalCash / t.adspend).toFixed(2) : 'n/a'}x`)
console.log(`ROAS (revenue/spend): ${t.adspend > 0 ? ((t.trial_rev + t.ascend_rev) / t.adspend).toFixed(2) : 'n/a'}x`)
console.log(`Leads:            ${t.leads}`)
console.log(`Qualified bookings: ${t.qb}`)
console.log(`Closes:           ${t.closes}`)
console.log(`Ascensions:       ${t.asc}`)
console.log(`Cost per lead:    ${t.leads > 0 ? '$' + (t.adspend / t.leads).toFixed(2) : 'n/a'}`)
console.log(`Cost per close:   ${t.closes > 0 ? '$' + (t.adspend / t.closes).toFixed(2) : 'n/a'}`)
