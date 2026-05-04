// Trace each of the 9 DQ prospects (per Ben's list) to their actual GHL
// contact + appointments. Print everything, no filtering, so we can see
// what's there and what isn't.

import { readFileSync } from 'node:fs'
const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const BASE = 'https://services.leadconnectorhq.com'
const headers = { Authorization: `Bearer ${env.VITE_GHL_API_KEY}`, Version: '2021-07-28' }

const dqEmails = [
  ['Charles',       'premierecontractingservice@gmail.com'],
  ['Thomas',        'thomas.walker@myvoda.com'],
  ['Yp',            'cheapvapestore@gmail.com'],
  ['Bryan Sharifi', 'bryansharifi@gmail.com'],
  ['Sam',           'sam-gray@live.com'],
  ['Vlad',          'vladyslavkyz@gmail.com'],
  ['Richard',       'RENOV84me@gmail.com'],
  ['Brian',         'callcarolinawater@gmail.com'],
  ['Jack',          'jack@prorestorationca.com'],
]

// Calendar id -> name lookup
const calNames = {}
async function calName(id) {
  if (calNames[id]) return calNames[id]
  const r = await fetch(`${BASE}/calendars/${id}`, { headers })
  if (!r.ok) { calNames[id] = '(unknown)'; return calNames[id] }
  const j = await r.json()
  calNames[id] = (j.calendar || j).name || '(unnamed)'
  return calNames[id]
}

const slugByCal = {}
console.log(`Tracing ${dqEmails.length} DQ-form-bucket prospects...\n`)
for (const [name, email] of dqEmails) {
  const r = await fetch(`${BASE}/contacts/search/duplicate?locationId=${env.VITE_GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`, { headers })
  if (!r.ok) { console.log(`${name.padEnd(15)} ${email.padEnd(40)}  → contact lookup HTTP ${r.status}`); continue }
  const j = await r.json()
  if (!j.contact) { console.log(`${name.padEnd(15)} ${email.padEnd(40)}  → NO CONTACT IN GHL`); continue }
  const r2 = await fetch(`${BASE}/contacts/${j.contact.id}/appointments`, { headers })
  if (!r2.ok) { console.log(`${name.padEnd(15)} ${email.padEnd(40)}  → appts HTTP ${r2.status}`); continue }
  const j2 = await r2.json()
  const events = j2.events || []
  if (!events.length) { console.log(`${name.padEnd(15)} ${email.padEnd(40)}  → 0 appointments`); continue }
  console.log(`${name.padEnd(15)} ${email.padEnd(40)}`)
  for (const e of events) {
    const cn = await calName(e.calendarId)
    console.log(`  cal=${e.calendarId} (${cn})  start=${e.startTime}  status=${e.appointmentStatus}  title="${e.title}"`)
    slugByCal[e.calendarId] = (slugByCal[e.calendarId] || 0) + 1
  }
}

console.log(`\n=== Calendar totals across all 9 DQ contacts (any time) ===`)
for (const [c, n] of Object.entries(slugByCal).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${c}  (${calNames[c]})  ${n} bookings`)
}
