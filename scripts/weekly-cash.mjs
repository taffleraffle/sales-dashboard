// Week-by-week spend + cash from marketing_tracker (Mon-Sun weeks)
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

const url = `${SUPABASE_URL}/rest/v1/marketing_tracker?select=date,adspend,leads,qualified_bookings,trial_cash,trial_revenue,ascend_cash,ascend_revenue,ar_collected,closes,ascensions&date=gte.${FROM}&date=lte.${TO}&order=date.asc`

const res = await fetch(url, {
  headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` },
})
if (!res.ok) {
  console.error('Supabase error:', res.status, await res.text())
  process.exit(1)
}
const rows = await res.json()

// Find Monday of the week for any date (UTC)
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z')
  const day = d.getUTCDay() // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().split('T')[0]
}

function sundayOf(mondayStr) {
  const d = new Date(mondayStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().split('T')[0]
}

const weeks = {}
for (const r of rows) {
  const wk = mondayOf(r.date)
  if (!weeks[wk]) weeks[wk] = {
    start: wk, end: sundayOf(wk), days: 0,
    adspend: 0, trial: 0, ascend: 0, ar: 0,
    leads: 0, qb: 0, closes: 0, asc: 0,
    trial_rev: 0, ascend_rev: 0,
  }
  const x = weeks[wk]
  x.days++
  x.adspend += Number(r.adspend || 0)
  x.trial += Number(r.trial_cash || 0)
  x.ascend += Number(r.ascend_cash || 0)
  x.ar += Number(r.ar_collected || 0)
  x.leads += r.leads || 0
  x.qb += r.qualified_bookings || 0
  x.closes += r.closes || 0
  x.asc += r.ascensions || 0
  x.trial_rev += Number(r.trial_revenue || 0)
  x.ascend_rev += Number(r.ascend_revenue || 0)
}

const fmt = n => '$' + n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const pad = (s, w) => String(s).padStart(w)

const fmtDateShort = s => {
  const [, m, d] = s.split('-')
  return `${Number(m)}/${Number(d)}`
}

const sortedKeys = Object.keys(weeks).sort()

console.log('\n=== WEEK-BY-WEEK SPEND vs. CASH (Mon–Sun) ===\n')
console.log('Week         Range            Days  Ad Spend    Trial $    Ascend $    AR $      TOTAL CASH   Cash ROAS  Revenue $    Rev ROAS  Leads  Closes  Asc')
console.log('---------    -------------    ----  ---------   --------   ---------   -------   ----------   ---------  ----------   --------  -----  ------  ----')

let prevMonth = null
for (const k of sortedKeys) {
  const x = weeks[k]
  const totalCash = x.trial + x.ascend + x.ar
  const totalRev = x.trial_rev + x.ascend_rev
  const cashRoas = x.adspend > 0 ? totalCash / x.adspend : 0
  const revRoas = x.adspend > 0 ? totalRev / x.adspend : 0
  const month = x.start.slice(0, 7) // group label
  if (prevMonth && prevMonth !== month) {
    console.log('  ·  ·  ·')
  }
  prevMonth = month
  console.log(
    `${x.start}   ${pad(fmtDateShort(x.start) + '–' + fmtDateShort(x.end), 13)}    ${pad(x.days, 4)}  ${pad(fmt(x.adspend), 9)}   ${pad(fmt(x.trial), 8)}   ${pad(fmt(x.ascend), 9)}   ${pad(fmt(x.ar), 7)}   ${pad(fmt(totalCash), 10)}   ${pad(cashRoas.toFixed(2) + 'x', 9)}  ${pad(fmt(totalRev), 10)}   ${pad(revRoas.toFixed(2) + 'x', 8)}  ${pad(x.leads, 5)}  ${pad(x.closes, 6)}  ${pad(x.asc, 4)}`
  )
}
