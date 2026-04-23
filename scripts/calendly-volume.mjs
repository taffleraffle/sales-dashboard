// Pull all bookings on the Calendly + Rebooking calendars, last 60 days,
// and bucket by status so Ben can see actual volume.
import { readFileSync } from 'fs'
const envText = readFileSync('.env', 'utf-8')
const env = {}
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/[\r\s]+$/, '').replace(/^["']|["']$/g, '')
}
const KEY = env.VITE_GHL_API_KEY
const LOC = env.VITE_GHL_LOCATION_ID
const BASE = 'https://services.leadconnectorhq.com'
const headers = { Authorization: `Bearer ${KEY}`, Version: '2021-04-15', Accept: 'application/json' }

const CALENDARS = [
  { id: 'T5Zif5GjDwulya6novU0', name: 'Opt Digital | Strategy Call (Calendly)' },
  { id: 'woLoGzGKe5fPKZU1jxY7', name: 'RestorationConnect AI - Rebooking' },
]

const now = Date.now()
const start = now - 60 * 24 * 3600 * 1000
const futureEnd = now + 30 * 24 * 3600 * 1000

for (const cal of CALENDARS) {
  const url = `${BASE}/calendars/events?locationId=${LOC}&calendarId=${cal.id}&startTime=${start}&endTime=${futureEnd}`
  const res = await fetch(url, { headers })
  if (!res.ok) {
    console.log(`\n=== ${cal.name} ===`)
    console.log(`  fetch failed: ${res.status}`)
    continue
  }
  const json = await res.json()
  const events = json.events || []
  console.log(`\n=== ${cal.name} (${events.length} bookings, last 60 + next 30 days) ===`)

  // Bucket by status
  const byStatus = {}
  const byDay = {}
  for (const e of events) {
    const s = e.appointmentStatus || 'unknown'
    byStatus[s] = (byStatus[s] || 0) + 1
    const d = (e.startTime || '').split(' ')[0] || (e.startTime || '').split('T')[0]
    if (d) byDay[d] = (byDay[d] || 0) + 1
  }
  console.log('  By status:')
  for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s}: ${n}`)
  }
  console.log('  By day (last 14 with bookings):')
  const days = Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14)
  for (const [d, n] of days) console.log(`    ${d}: ${n}`)

  // Sample 5 most recent
  console.log('  Most recent 8 bookings:')
  const recent = [...events].sort((a, b) => (b.startTime || '').localeCompare(a.startTime || '')).slice(0, 8)
  for (const e of recent) {
    console.log(`    ${e.startTime}  status=${e.appointmentStatus}  title=${(e.title || '').slice(0, 50)}  bookedAt=${e.dateAdded}`)
  }
}
