import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] })
)
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

const today = new Date('2026-05-06')
const start = new Date(today); start.setDate(start.getDate() - 120)
const startStr = start.toISOString().slice(0, 10)
console.log(`Window: ${startStr} → ${today.toISOString().slice(0,10)}\n`)

// Pull all confirmed EOD reports in window
const { data: eod } = await sb.from('closer_eod_reports')
  .select('report_date, live_nc_calls, live_fu_calls, offers, closes, total_revenue, total_cash_collected')
  .gte('report_date', startStr)
  .eq('is_confirmed', true)
  .order('report_date')

console.log(`Total confirmed EOD reports in window: ${eod?.length || 0}\n`)

// Bucket by 14-day intervals (most-recent bucket ends today)
const BUCKET_DAYS = 14
const buckets = []
for (let i = 0; i < 120 / BUCKET_DAYS; i++) {
  const end = new Date(today); end.setDate(end.getDate() - i * BUCKET_DAYS)
  const begin = new Date(end); begin.setDate(begin.getDate() - BUCKET_DAYS + 1)
  buckets.push({
    label: `${begin.toISOString().slice(0,10)} → ${end.toISOString().slice(0,10)}`,
    begin: begin.toISOString().slice(0,10),
    end: end.toISOString().slice(0,10),
    live_nc: 0, live_fu: 0, offers: 0, closes: 0, revenue: 0, cash: 0,
  })
}

for (const r of eod || []) {
  const d = r.report_date
  for (const b of buckets) {
    if (d >= b.begin && d <= b.end) {
      b.live_nc += r.live_nc_calls || 0
      b.live_fu += r.live_fu_calls || 0
      b.offers += r.offers || 0
      b.closes += r.closes || 0
      b.revenue += parseFloat(r.total_revenue || 0)
      b.cash += parseFloat(r.total_cash_collected || 0)
      break
    }
  }
}

// Print most-recent first
console.log('=== Closing Rate Trend (14-day buckets) ===\n')
console.log('Window'.padEnd(28), 'LiveNC'.padStart(7), 'Offers'.padStart(7), 'Closes'.padStart(7), 'Close%'.padStart(8), 'Offer%'.padStart(8), 'Revenue'.padStart(12))
console.log('-'.repeat(80))
for (const b of buckets) {
  const closeRate = b.live_nc > 0 ? (b.closes / b.live_nc) * 100 : 0
  const offerRate = b.live_nc > 0 ? (b.offers / b.live_nc) * 100 : 0
  console.log(
    b.label.padEnd(28),
    String(b.live_nc).padStart(7),
    String(b.offers).padStart(7),
    String(b.closes).padStart(7),
    `${closeRate.toFixed(1)}%`.padStart(8),
    `${offerRate.toFixed(1)}%`.padStart(8),
    `$${Math.round(b.revenue).toLocaleString()}`.padStart(12),
  )
}
