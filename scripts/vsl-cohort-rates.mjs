// Compute show/reschedule/close rates for the VSL → Typeform → Calendly cohort.
// Input: hard-coded list of 12 leads from the Typeform export.
// For each, pull GHL contact, all appointments, opportunity (pipeline stage),
// and infer outcome from a combination of appointmentStatus + pipeline stage.
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

const CALENDLY_CALENDAR_ID = 'T5Zif5GjDwulya6novU0'  // Opt Digital | Strategy Call (Calendly)

// SCIO pipeline stage names by id (from earlier lookup)
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

// Cohort: 12 leads from typeform export (status from typeform = Completed/Partial)
const COHORT = [
  { email: 'cruiz@fungienvironmentalseevices.com', typeform: 'Partial' },
  { email: 'otmrei@gmail.com', typeform: 'Partial' },
  { email: 'esmbpropertysolutions@gmail.com', typeform: 'Partial' },
  { email: 'joe@restorationserviceskc.com', typeform: 'Completed' },
  { email: '1993gio@live.com', typeform: 'Completed' },
  { email: 'juanp.castanedav@gmail.com', typeform: 'Completed' },
  { email: 'rich@reactrestores.net', typeform: 'Partial' },
  { email: 'angelo@preferredchoicerestorations.com', typeform: 'Partial' },
  { email: 'chris.helveston@restoration1.com', typeform: 'Completed' },
  { email: 'jason@dry1out.com', typeform: 'Completed' },
  { email: 'premierecontractingservice@gmail.com', typeform: 'Completed' },
  { email: 'christian@swiftdryrestore.cm', typeform: '?' },
]

async function ghl(path, version = '2021-07-28') {
  const r = await fetch(`${BASE}${path}`, { headers: { ...headers, Version: version } })
  const t = await r.text()
  let j; try { j = JSON.parse(t) } catch { j = {} }
  return { ok: r.ok, status: r.status, j }
}

async function lookup(email) {
  const r = await ghl(`/contacts/search/duplicate?locationId=${LOC}&email=${encodeURIComponent(email)}`)
  const contact = r.j.contact
  if (!contact) return { email, found: false }

  const [appts, opps] = await Promise.all([
    ghl(`/contacts/${contact.id}/appointments`),
    ghl(`/opportunities/search?location_id=${LOC}&contact_id=${contact.id}`),
  ])

  const allAppts = (appts.j.events || []).filter(e => e.calendarId === CALENDLY_CALENDAR_ID)
  const calBookings = allAppts.length
  const cancelled = allAppts.filter(e => e.appointmentStatus === 'cancelled').length
  const confirmed = allAppts.filter(e => e.appointmentStatus === 'confirmed').length
  const showed = allAppts.filter(e => e.appointmentStatus === 'showed').length
  const noshow = allAppts.filter(e => e.appointmentStatus === 'noshow').length

  // Reschedule signal: more than 1 appointment on the calendar (one cancelled + one new)
  const rescheduled = calBookings > 1

  const opp = (opps.j.opportunities || [])[0]
  const stage = opp ? STAGES[opp.pipelineStageId] || opp.pipelineStageId : null

  // Outcome inference: stage > status > tags
  const tags = contact.tags || []
  const closedTag = tags.some(t => /^opt-trial-paid$|^closed$|^client$/i.test(t))

  return {
    email,
    found: true,
    contactId: contact.id,
    name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || '(no name)',
    bookings: calBookings,
    confirmed, cancelled, showed, noshow,
    rescheduled,
    stage,
    tags: tags.slice(0, 6),
    closedTag,
    apptDates: allAppts.map(e => `${(e.startTime||'').slice(0,16)} [${e.appointmentStatus}]`),
  }
}

console.log(`\nLooking up ${COHORT.length} cohort leads in GHL...\n`)
const results = await Promise.all(COHORT.map(c => lookup(c.email).then(r => ({ ...c, ...r }))))

// Per-lead breakdown
console.log('=== PER-LEAD ===')
console.log('email | typeform | found | bookings | stage | rescheduled | apptDates')
console.log('-'.repeat(100))
for (const r of results) {
  if (!r.found) {
    console.log(`${r.email.padEnd(45)} | ${r.typeform.padEnd(9)} | NOT IN GHL`)
    continue
  }
  console.log(`${r.email.padEnd(45)} | ${r.typeform.padEnd(9)} | ${r.name.padEnd(20)} | bookings=${r.bookings} | stage="${r.stage}" | rescheduled=${r.rescheduled}`)
  for (const d of r.apptDates) console.log(`     · ${d}`)
}

// Aggregate
const inGhl = results.filter(r => r.found)
const booked = inGhl.filter(r => r.bookings > 0)
const rescheduledN = booked.filter(r => r.rescheduled).length
const showedN = inGhl.filter(r => r.showed > 0 || ['Closed', 'Ascended Trials', 'Nurture', 'Not Interested'].includes(r.stage)).length
const noshowN = inGhl.filter(r => r.stage === 'No Show (Confirmed)' || r.noshow > 0).length
const stillSetCall = inGhl.filter(r => r.stage === 'Set Call').length
const closedN = inGhl.filter(r => r.stage === 'Closed' || r.stage === 'Ascended Trials' || r.closedTag).length

console.log('\n=== AGGREGATE (cohort = 12 typeform leads, mix of Completed + Partial) ===')
console.log(`  In GHL:                ${inGhl.length} / ${COHORT.length}`)
console.log(`  Booked on Calendly:    ${booked.length} / ${inGhl.length}  (${pct(booked.length, inGhl.length)})`)
console.log(`  Rescheduled:           ${rescheduledN} / ${booked.length}  (${pct(rescheduledN, booked.length)})`)
console.log(`  Showed (or moved past Set Call): ${showedN} / ${booked.length}  (${pct(showedN, booked.length)})`)
console.log(`  No-show (stage = No Show or apptStatus = noshow): ${noshowN} / ${booked.length}  (${pct(noshowN, booked.length)})`)
console.log(`  Still in Set Call (no outcome recorded): ${stillSetCall}`)
console.log(`  Closed (stage = Closed/Ascended OR closed tag): ${closedN} / ${booked.length}  (${pct(closedN, booked.length)})`)

// Booking rate vs Completed-only typeforms
const completed = results.filter(r => r.typeform === 'Completed' && r.found)
const completedBooked = completed.filter(r => r.bookings > 0).length
console.log(`\n  Booking rate of "Completed" typeforms: ${completedBooked} / ${completed.length}  (${pct(completedBooked, completed.length)})`)

function pct(num, den) {
  if (!den) return '—'
  return `${(num / den * 100).toFixed(0)}%`
}
