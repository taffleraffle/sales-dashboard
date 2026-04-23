// Pull every booking on the Calendly calendar, dedupe by contact, look up
// each contact's pipeline stage, and bucket as Showed / No-Show / Reschedule.
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
const headers = { Authorization: `Bearer ${KEY}`, Version: '2021-07-28', Accept: 'application/json' }

const CAL_ID = 'T5Zif5GjDwulya6novU0'
const STAGES = {
  'bdac7fc6-7f92-4bc3-be8e-a033744d11f0': 'Autobookings (VSL)',
  'fc1096e8-7337-4c1a-8ae6-40efc3502afe': 'New Leads',
  '99e596a1-5c90-4766-93b7-ba940deb3b08': 'Attempting Contact',
  'c5ee5195-ac12-4b37-b3fb-2accc6637a87': 'Auto-booked Triage',
  '33c00f0c-0202-4c29-a835-b7b3f2dd491d': 'Triage Confirmed',
  'cb8992ab-3823-49bc-9d87-6f4ec95a9cc8': 'Triage Booked No Shows',
  '0a2ea6d0-6ddf-49ff-972c-45658e8d7e13': 'Set Call',
  'f9a2aa2d-943b-46c8-ac01-307792d48e49': 'No Show (Confirmed)',
  'cce108b0-93dc-4914-8549-81c18d1d18fe': 'Nurture',
  'b7dc415a-f0a4-41dd-b113-741929eb517b': 'Closed',
  '0f9d5445-37da-487b-8925-6e0d7d35386b': 'Ascended Trials',
  '58d7944e-834a-4b08-851a-faa4e1c3c7a6': 'Not Interested',
  '8cf99504-d718-4895-9344-8842fd3c4a86': 'Dead Contact',
}

async function ghl(path, version = '2021-07-28') {
  const r = await fetch(`${BASE}${path}`, { headers: { ...headers, Version: version } })
  const t = await r.text()
  let j; try { j = JSON.parse(t) } catch { j = {} }
  return { ok: r.ok, status: r.status, j }
}

// 1. Pull all bookings on the calendar (last 90 days + future 30)
const now = Date.now()
const start = now - 90 * 24 * 3600 * 1000
const end = now + 30 * 24 * 3600 * 1000
const url = `${BASE}/calendars/events?locationId=${LOC}&calendarId=${CAL_ID}&startTime=${start}&endTime=${end}`
const evRes = await fetch(url, { headers: { ...headers, Version: '2021-04-15' } })
const events = (await evRes.json()).events || []

// 2. Filter out test bookings + group by contactId
const TEST_RX = /^(test|new test|asdf|qwer)\b/i
const real = events.filter(e => !TEST_RX.test(e.title || ''))
const byContact = {}
for (const e of real) {
  const id = e.contactId
  if (!id) continue
  if (!byContact[id]) byContact[id] = []
  byContact[id].push(e)
}
const tests = events.length - real.length

// 3. For each unique contact, fetch contact + opportunity in parallel
const contactIds = Object.keys(byContact)
const results = await Promise.all(contactIds.map(async (cid) => {
  const events = byContact[cid].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))
  const [c, o] = await Promise.all([
    ghl(`/contacts/${cid}`),
    ghl(`/opportunities/search?location_id=${LOC}&contact_id=${cid}`),
  ])
  const contact = c.j.contact || {}
  const opp = (o.j.opportunities || [])[0]
  const stage = opp ? (STAGES[opp.pipelineStageId] || opp.pipelineStageId) : null
  return {
    contactId: cid,
    name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || '(no name)',
    email: contact.email || '',
    phone: contact.phone || '',
    bookings: events.length,
    events,
    stage,
    tags: contact.tags || [],
  }
}))

// 4. Bucket each contact
function classify(r) {
  // Reschedule: more than one booking on this calendar
  if (r.bookings > 1) return 'reschedule'
  // No-show: stage explicitly says so
  if (r.stage === 'No Show (Confirmed)' || r.stage === 'Triage Booked No Shows') return 'no_show'
  // Showed: moved past Set Call into a post-show stage
  if (['Closed', 'Ascended Trials', 'Nurture', 'Not Interested'].includes(r.stage)) return 'showed'
  // Cancelled/dead before show
  if (r.stage === 'Dead Contact') return 'dead'
  // Future appointment that hasn't happened
  const last = r.events[r.events.length - 1]
  const lastTime = new Date(last.startTime || 0).getTime()
  if (lastTime > now && last.appointmentStatus !== 'cancelled') return 'pending'
  // Cancelled, never re-booked
  if (last.appointmentStatus === 'cancelled') return 'cancelled_no_rebook'
  // Confirmed booking, time has passed, but no outcome recorded
  return 'no_outcome_logged'
}

const buckets = { showed: [], no_show: [], reschedule: [], cancelled_no_rebook: [], pending: [], dead: [], no_outcome_logged: [] }
for (const r of results) buckets[classify(r)].push(r)

// 5. Print clean breakdown
const labels = {
  showed: '✅ SHOWED (moved past Set Call to a post-show stage)',
  no_show: '❌ NO-SHOW (stage = No Show Confirmed or Triage Booked No Shows)',
  reschedule: '🔄 RESCHEDULE (>1 booking on Calendly)',
  cancelled_no_rebook: '⛔ CANCELLED — never re-booked',
  pending: '⏳ PENDING — confirmed future booking',
  dead: '💀 DEAD CONTACT (post-call, ghosted)',
  no_outcome_logged: '⚠️  NO OUTCOME LOGGED — call date passed, GHL stage still says "Set Call" or no opp',
}

console.log(`\nTotal bookings on Calendly (last 90d + future 30d): ${events.length}`)
console.log(`Excluded ${tests} obvious test bookings`)
console.log(`Real bookings: ${real.length} across ${contactIds.length} unique contacts\n`)

for (const [bucket, rows] of Object.entries(buckets)) {
  if (!rows.length) continue
  console.log(`\n${labels[bucket]}  —  ${rows.length} contact(s)`)
  console.log('-'.repeat(80))
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(28)} ${r.email.padEnd(40)} stage="${r.stage || 'NONE'}"`)
    for (const e of r.events) {
      console.log(`    · ${(e.startTime||'').slice(0,16)}  ${e.appointmentStatus.padEnd(10)} title="${(e.title || '').slice(0, 40)}"`)
    }
  }
}

// Summary table
console.log('\n=== SUMMARY ===')
const total = contactIds.length
const showed = buckets.showed.length
const noShow = buckets.no_show.length
const reschedule = buckets.reschedule.length
const pending = buckets.pending.length
const dead = buckets.dead.length
const cancelled = buckets.cancelled_no_rebook.length
const noOutcome = buckets.no_outcome_logged.length

const completedCalls = total - pending - reschedule  // calls where the date has passed for the latest booking
console.log(`  Showed:                        ${showed}  (${pct(showed, total)})`)
console.log(`  No-show (confirmed):           ${noShow}  (${pct(noShow, total)})`)
console.log(`  Reschedule:                    ${reschedule}  (${pct(reschedule, total)})`)
console.log(`  Cancelled, no re-book:         ${cancelled}  (${pct(cancelled, total)})`)
console.log(`  Pending future booking:        ${pending}`)
console.log(`  Dead contact (post):           ${dead}`)
console.log(`  No outcome logged in GHL:      ${noOutcome}  ⚠ blind spot`)
console.log(`  Total unique contacts:         ${total}`)

function pct(n, d) { return d ? `${(n / d * 100).toFixed(0)}%` : '—' }
