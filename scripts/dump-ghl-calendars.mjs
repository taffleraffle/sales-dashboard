// One-shot diagnostic: list every GHL calendar + a sample of recent events per calendar.
// Run: node scripts/dump-ghl-calendars.mjs

import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const BASE = 'https://services.leadconnectorhq.com'
const KEY = env.VITE_GHL_API_KEY
const LOC = env.VITE_GHL_LOCATION_ID

if (!KEY || !LOC) {
  console.error('Missing VITE_GHL_API_KEY or VITE_GHL_LOCATION_ID in .env')
  process.exit(1)
}

const headers = { Authorization: `Bearer ${KEY}`, Version: '2021-07-28' }

async function main() {
  // 1) List calendars
  const calRes = await fetch(`${BASE}/calendars/?locationId=${LOC}`, { headers })
  if (!calRes.ok) {
    console.error(`calendars/ failed: ${calRes.status} ${await calRes.text()}`)
    process.exit(1)
  }
  const { calendars = [] } = await calRes.json()
  console.log(`\n=== ${calendars.length} CALENDARS ===\n`)
  for (const c of calendars) {
    console.log(`${c.id}  ${c.name}${c.isActive === false ? '  [INACTIVE]' : ''}`)
  }

  // 2) For the last 7 days, count events per calendar via /calendars/events
  const now = Date.now()
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
  const sevenDaysAhead = now + 7 * 24 * 60 * 60 * 1000

  console.log(`\n=== EVENT COUNTS PER CALENDAR (last 7d → next 7d) ===\n`)
  for (const c of calendars) {
    const url = `${BASE}/calendars/events?locationId=${LOC}&calendarId=${c.id}&startTime=${sevenDaysAgo}&endTime=${sevenDaysAhead}`
    const r = await fetch(url, { headers })
    if (!r.ok) {
      console.log(`${c.id}  ${c.name}  → ERROR ${r.status}`)
      continue
    }
    const json = await r.json()
    const events = json.events || []
    if (events.length === 0) continue
    console.log(`${c.id}  ${c.name}  → ${events.length} events`)
    // Sample first event for shape inspection
    const sample = events[0]
    console.log(`   sample: title="${sample.title || ''}" assignedUserId="${sample.assignedUserId || ''}" status="${sample.appointmentStatus || ''}" start="${sample.startTime || ''}"`)
  }
  console.log()
}

main().catch(e => { console.error(e); process.exit(1) })
