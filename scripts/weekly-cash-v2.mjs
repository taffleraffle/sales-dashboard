// Weekly + monthly spend/cash with cost-per metrics
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

const url = `${SUPABASE_URL}/rest/v1/marketing_tracker?select=date,adspend,leads,qualified_bookings,calls_on_calendar,live_calls,net_live_calls,new_live_calls,trial_cash,trial_revenue,ascend_cash,ascend_revenue,ar_collected,closes,ascensions&date=gte.${FROM}&date=lte.${TO}&order=date.asc`

const res = await fetch(url, {
  headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` },
})
if (!res.ok) {
  console.error('Supabase error:', res.status, await res.text())
  process.exit(1)
}
const rows = await res.json()

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z')
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().split('T')[0]
}
function sundayOf(mondayStr) {
  const d = new Date(mondayStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().split('T')[0]
}

const fmt = n => '$' + n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const fmt2 = n => '$' + n.toFixed(2)
const fmtDate = s => { const [, m, d] = s.split('-'); return `${Number(m)}/${Number(d)}` }

function emptyAcc() {
  return {
    days: 0, adspend: 0, trial: 0, ascend: 0, ar: 0,
    leads: 0, qb: 0, calls_cal: 0, live_calls: 0,
    closes: 0, asc: 0, trial_rev: 0, ascend_rev: 0,
  }
}
function addRow(acc, r) {
  acc.days++
  acc.adspend += Number(r.adspend || 0)
  acc.trial += Number(r.trial_cash || 0)
  acc.ascend += Number(r.ascend_cash || 0)
  acc.ar += Number(r.ar_collected || 0)
  acc.leads += r.leads || 0
  acc.qb += r.qualified_bookings || 0
  // Booked calls: prefer calls_on_calendar, fall back to qualified_bookings
  acc.calls_cal += (r.calls_on_calendar ?? r.qualified_bookings) || 0
  // Live calls: prefer live_calls, fall back to net_live_calls
  acc.live_calls += (r.live_calls ?? r.net_live_calls) || 0
  acc.closes += r.closes || 0
  acc.asc += r.ascensions || 0
  acc.trial_rev += Number(r.trial_revenue || 0)
  acc.ascend_rev += Number(r.ascend_revenue || 0)
}

// Group by week + by month
const weeks = {}
const months = {}
for (const r of rows) {
  const wk = mondayOf(r.date)
  const mo = r.date.slice(0, 7)
  if (!weeks[wk]) weeks[wk] = { ...emptyAcc(), start: wk, end: sundayOf(wk) }
  if (!months[mo]) months[mo] = emptyAcc()
  addRow(weeks[wk], r)
  addRow(months[mo], r)
}

// Print
function summary(label, x) {
  const totalCash = x.trial + x.ascend + x.ar
  const totalRev = x.trial_rev + x.ascend_rev
  const cpl = x.leads > 0 ? x.adspend / x.leads : 0
  const cpb = x.calls_cal > 0 ? x.adspend / x.calls_cal : 0
  const cplive = x.live_calls > 0 ? x.adspend / x.live_calls : 0
  console.log(`${label}: ad=${fmt(x.adspend)} cash=${fmt(totalCash)} rev=${fmt(totalRev)} leads=${x.leads} bookings=${x.calls_cal} live=${x.live_calls} closes=${x.closes} asc=${x.asc} | CPL=${fmt2(cpl)} CPB=${fmt2(cpb)} CPLive=${fmt2(cplive)}`)
}

console.log('\n=== WEEKLY ===')
for (const k of Object.keys(weeks).sort()) summary(`${weeks[k].start} (${weeks[k].days}d)`, weeks[k])
console.log('\n=== MONTHLY ===')
for (const k of Object.keys(months).sort()) summary(k, months[k])
