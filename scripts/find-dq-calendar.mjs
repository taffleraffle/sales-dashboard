// Pull the Calendly URLs out of the form CSV, then trace back to GHL to find
// which calendar(s) those bookings land on. Goal: identify any DQ calendar
// we're missing from STRATEGY_CALL_CALENDARS / DQ_BOOKING_CALENDARS.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

function parseCSV(s) {
  const rows = []; let row = [], cell = '', i = 0, q = false
  while (i < s.length) {
    const c = s[i]
    if (q) { if (c === '"' && s[i+1] === '"') { cell += '"'; i += 2; continue } if (c === '"') { q = false; i++; continue } cell += c; i++; continue }
    if (c === '"') { q = true; i++; continue }
    if (c === ',') { row.push(cell); cell = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue }
    cell += c; i++
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row) }
  return rows
}

const raw = readFileSync('C:/Users/Ben/Downloads/responses-h4il4Sla-01KQTHGAWMABF97MFPGZTWP67G-NW08C5R2MMCMMD0FKU8YXJJH.csv', 'utf8')
const rows = parseCSV(raw)
const data = rows.slice(1).filter(r => r.some(c => c && c.trim()))

const sevenAgoUTC = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]

// Each row has 30+ columns — col 10 = "IMPORTANT: Please Book A Call Below" (DQ link)
// col 11 = "Great! Please Book in a Call" (qualified link)
// Check both — they hold Calendly invitee URLs after redirect.
console.log(`=== Form rows in last 7d with their booking URLs ===\n`)
let qualifiedURLs = [], dqURLs = []
for (const r of data) {
  const submit = (r[25] || '').slice(0, 10)
  if (submit < sevenAgoUTC) continue
  const dqLink = (r[10] || '').trim()
  const qualifiedLink = (r[11] || '').trim()
  const ending = (r[28] || '').trim()
  const email = (r[6] || '').trim()
  if (qualifiedLink) qualifiedURLs.push({ email, url: qualifiedLink })
  if (dqLink) dqURLs.push({ email, url: dqLink })
  if (qualifiedLink || dqLink) {
    console.log(`  ${submit}  ${email.padEnd(35)}  ending="${ending}"`)
    if (qualifiedLink) console.log(`     QUAL: ${qualifiedLink.slice(0, 100)}`)
    if (dqLink)        console.log(`     DQ:   ${dqLink.slice(0, 100)}`)
  }
}
console.log(`\nQualified URLs captured: ${qualifiedURLs.length}`)
console.log(`DQ URLs captured: ${dqURLs.length}`)

// Extract unique Calendly slugs from DQ URLs
const dqSlugs = new Set()
for (const { url } of dqURLs) {
  const m = url.match(/calendly\.com\/([^/?#]+(?:\/[^/?#]+)?)/i)
  if (m) dqSlugs.add(m[1])
}
console.log(`\n=== Unique Calendly slugs in DQ links ===`)
for (const s of dqSlugs) console.log(`  ${s}`)

// Same for qualified
const qualSlugs = new Set()
for (const { url } of qualifiedURLs) {
  const m = url.match(/calendly\.com\/([^/?#]+(?:\/[^/?#]+)?)/i)
  if (m) qualSlugs.add(m[1])
}
console.log(`\n=== Unique Calendly slugs in qualified links ===`)
for (const s of qualSlugs) console.log(`  ${s}`)

// Now: for each DQ-URL email, find their GHL contact + appointments.
console.log(`\n=== Looking up GHL appointments per form-bucket ===\n`)
const BASE = 'https://services.leadconnectorhq.com'
const headers = { Authorization: `Bearer ${env.VITE_GHL_API_KEY}`, Version: '2021-07-28' }

// Also lookup the qualified-link emails to compare
const qualByCal = {}
console.log(`--- QUALIFIED-LINK contacts (form col 11 = "Great! Please Book") ---`)
for (const { email } of qualifiedURLs) {
  if (!email) continue
  const r = await fetch(`${BASE}/contacts/search/duplicate?locationId=${env.VITE_GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`, { headers })
  if (!r.ok) continue
  const j = await r.json()
  if (!j.contact) continue
  const r2 = await fetch(`${BASE}/contacts/${j.contact.id}/appointments`, { headers })
  if (!r2.ok) continue
  const j2 = await r2.json()
  // Only count appointments booked recently (last 7 days)
  const sevenAgo = new Date(Date.now() - 7 * 86400000)
  for (const e of (j2.events || [])) {
    if (!e.dateAdded) continue
    const da = new Date(e.dateAdded)
    if (da < sevenAgo) continue
    qualByCal[e.calendarId] = (qualByCal[e.calendarId] || 0) + 1
    console.log(`  ${email}  → cal=${e.calendarId}  start=${e.startTime}  status=${e.appointmentStatus}`)
  }
}

console.log(`\n--- DQ-LINK contacts (form col 10 = "IMPORTANT: Please Book") ---`)
const calendarsSeen = {}
let foundCount = 0
for (const { email, url } of dqURLs) {
  if (!email) continue
  const r = await fetch(`${BASE}/contacts/search/duplicate?locationId=${env.VITE_GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`, { headers })
  if (!r.ok) { continue }
  const j = await r.json()
  if (!j.contact) { continue }
  const r2 = await fetch(`${BASE}/contacts/${j.contact.id}/appointments`, { headers })
  if (!r2.ok) { continue }
  const j2 = await r2.json()
  const sevenAgo = new Date(Date.now() - 7 * 86400000)
  for (const e of (j2.events || [])) {
    if (!e.dateAdded) continue
    const da = new Date(e.dateAdded)
    if (da < sevenAgo) continue
    calendarsSeen[e.calendarId] = (calendarsSeen[e.calendarId] || 0) + 1
    foundCount++
    console.log(`  ${email}  → cal=${e.calendarId}  start=${e.startTime}  status=${e.appointmentStatus}`)
  }
}

console.log(`\n=== Summary: where did each form bucket actually book? ===\n`)
console.log(`QUALIFIED-LINK bucket (col 11 "Great!"):`)
for (const [cal, n] of Object.entries(qualByCal)) console.log(`  ${cal}  ${n} bookings`)
console.log(`\nDQ-LINK bucket (col 10 "IMPORTANT"):`)
for (const [cal, n] of Object.entries(calendarsSeen)) console.log(`  ${cal}  ${n} bookings`)

console.log(`\nContacts with appointments: ${foundCount}/${dqURLs.length}`)
console.log(`\n=== Calendar IDs that DQ-link contacts have appointments on ===`)
for (const [calId, cnt] of Object.entries(calendarsSeen).sort((a,b) => b[1]-a[1])) {
  // Look up calendar name
  const cr = await fetch(`${BASE}/calendars/${calId}`, { headers })
  let name = '(unknown)'
  if (cr.ok) {
    const cj = await cr.json()
    name = (cj.calendar || cj).name || '(unnamed)'
  }
  console.log(`  ${calId}  count=${cnt}  name="${name}"`)
}

// Are any of these calendars in our ghl_appointments table?
console.log(`\n=== Of these calendars, are they synced into ghl_appointments? ===`)
for (const calId of Object.keys(calendarsSeen)) {
  const { count } = await supabase
    .from('ghl_appointments')
    .select('*', { count: 'exact', head: true })
    .eq('calendar_name', calId)
  console.log(`  ${calId}  rows in ghl_appointments=${count}`)
}
