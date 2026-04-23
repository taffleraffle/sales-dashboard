// One-off lookup: pull everything we can on a single contact from GHL.
// Usage: node scripts/lookup-joe.mjs <email>
import { readFileSync } from 'fs'

// Load .env manually (no dotenv dep in this repo's scripts)
const envText = readFileSync('.env', 'utf-8')
const env = {}
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/[\r\s]+$/, '').replace(/^["']|["']$/g, '')
}

const KEY = env.VITE_GHL_API_KEY
const LOC = env.VITE_GHL_LOCATION_ID
const BASE = 'https://services.leadconnectorhq.com'
const EMAIL = process.argv[2] || 'joe@restorationserviceskc.com'

if (!KEY || !LOC) {
  console.error('Missing VITE_GHL_API_KEY or VITE_GHL_LOCATION_ID in .env')
  process.exit(1)
}

const headers = {
  Authorization: `Bearer ${KEY}`,
  Version: '2021-07-28',
  Accept: 'application/json',
}

async function ghl(path, version = '2021-07-28') {
  const res = await fetch(`${BASE}${path}`, { headers: { ...headers, Version: version } })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = { _raw: text } }
  return { ok: res.ok, status: res.status, json }
}

console.log(`\nLooking up ${EMAIL}...\n`)

// 1. Find contact by email
const search = await ghl(`/contacts/search/duplicate?locationId=${LOC}&email=${encodeURIComponent(EMAIL)}`)
if (!search.ok) {
  console.log('Search failed:', search.status, JSON.stringify(search.json).slice(0, 300))
  process.exit(1)
}

const contact = search.json.contact
if (!contact) {
  console.log('No contact found with that email.')
  process.exit(0)
}

console.log('=== CONTACT ===')
console.log('  ID:        ', contact.id)
console.log('  Name:      ', `${contact.firstName || ''} ${contact.lastName || ''}`.trim())
console.log('  Email:     ', contact.email)
console.log('  Phone:     ', contact.phone)
console.log('  Company:   ', contact.companyName || '(none)')
console.log('  Source:    ', contact.source || '(none)')
console.log('  Created:   ', contact.dateAdded)
console.log('  Tags:      ', (contact.tags || []).join(', ') || '(none)')
console.log('  AssignedTo:', contact.assignedTo || '(none)')

// 2. Fetch appointments
const appts = await ghl(`/contacts/${contact.id}/appointments`)
console.log('\n=== APPOINTMENTS ===')
if (!appts.ok) {
  console.log('  Fetch failed:', appts.status)
} else {
  const events = appts.json.events || []
  if (!events.length) console.log('  (none)')
  for (const e of events) {
    console.log(`  • ${e.startTime || '(no time)'}  status=${e.appointmentStatus}  calendarId=${e.calendarId}`)
    console.log(`    title: ${e.title || '(no title)'}`)
    console.log(`    eventId: ${e.id}  bookedAt: ${e.dateAdded || '(unknown)'}  assignedTo: ${e.assignedUserId || '(none)'}`)
  }
}

// 3. Resolve calendar IDs to names by listing all calendars
const cals = await ghl(`/calendars/?locationId=${LOC}`)
if (cals.ok) {
  const byId = {}
  for (const c of (cals.json.calendars || [])) byId[c.id] = c.name
  console.log('\n=== CALENDAR ID → NAME (joe\'s appts only) ===')
  const seen = new Set((appts.json.events || []).map(e => e.calendarId))
  for (const id of seen) console.log(`  ${id}  →  ${byId[id] || '(unknown)'}`)
}

// 4. Fetch opportunities (pipeline stage history)
const opps = await ghl(`/opportunities/search?location_id=${LOC}&contact_id=${contact.id}`)
console.log('\n=== OPPORTUNITIES ===')
if (opps.ok) {
  const list = opps.json.opportunities || []
  if (!list.length) console.log('  (none)')
  for (const o of list) {
    console.log(`  • ${o.name || '(unnamed)'}`)
    console.log(`    pipeline=${o.pipelineId}  stage=${o.pipelineStageId}  status=${o.status}`)
    console.log(`    monetaryValue=${o.monetaryValue}  source=${o.source}`)
    console.log(`    created=${o.createdAt}  updated=${o.updatedAt}`)
    if (o.assignedTo) console.log(`    assignedTo=${o.assignedTo}`)
  }
} else {
  console.log('  Fetch failed:', opps.status)
}

// 5. Fetch conversation summary
const conv = await ghl(`/conversations/search?locationId=${LOC}&contactId=${contact.id}`)
console.log('\n=== CONVERSATION ===')
if (conv.ok) {
  const c = conv.json.conversations?.[0]
  if (!c) console.log('  (none)')
  else {
    console.log(`  ID: ${c.id}`)
    console.log(`  Last message: ${c.lastMessageDate}  (${c.lastMessageType || '?'})`)
    console.log(`  Unread count: ${c.unreadCount}`)
    // Pull the actual messages
    const msgs = await ghl(`/conversations/${c.id}/messages`)
    if (msgs.ok) {
      const messages = msgs.json.messages?.messages || []
      console.log(`  ${messages.length} messages total`)
      for (const m of messages.slice(0, 20)) {
        const dir = m.direction === 'inbound' ? '←' : '→'
        const body = (m.body || '').replace(/\s+/g, ' ').slice(0, 120)
        console.log(`    ${dir} [${m.dateAdded}] ${m.messageType}: ${body}`)
      }
      if (messages.length > 20) console.log(`    ... ${messages.length - 20} more`)
    }
  }
}
