// One-shot backfill: pull events for last 60d → next 30d via /calendars/events
// (per userId + per calendarId), upsert into ghl_appointments. Mirrors the
// browser-side syncGHLAppointments rewrite so ghl_appointments matches what
// the new code will produce.
//
// Run: node scripts/backfill-ghl-appointments.mjs

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY
const GHL_KEY = env.VITE_GHL_API_KEY
const GHL_LOC = env.VITE_GHL_LOCATION_ID

if (!SUPABASE_URL || !SUPABASE_KEY || !GHL_KEY || !GHL_LOC) {
  console.error('Missing required env vars')
  process.exit(1)
}

// Mirror src/utils/constants.js
const INTRO_CALENDARS = [
  '5omixNmtgmGMWQfEL0fs', 'C5NRRAjwsy43nOyU6izQ',
  'GpYh75LaFEJgpHYkZfN9', 'okWMyvLhnJ7sbuvSIzok', 'MvYStrHFsRTpunwTXIqT',
]
const STRATEGY_CALL_CALENDARS = [
  '9yoQVPBkNX4tWYmcDkf3', 'cEyqCFAsPLDkUV8n982h', 'HDsTrgpsFOXw9V4AkZGq',
  'aQsmGwANALCwJBI7G9vT', 'StLqrES6WMO8f3Obdu9d', '3mLE6t6rCKDdIuIfvP9j',
  'T5Zif5GjDwulya6novU0', 'gohFzPCilzwBtVfaC6fu',
]

const BASE = 'https://services.leadconnectorhq.com'
const headers = { Authorization: `Bearer ${GHL_KEY}`, Version: '2021-07-28' }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

function parseEventDateTime(s) {
  if (!s) return null
  if (s.includes('T')) {
    const d = new Date(s)
    if (isNaN(d.getTime())) return null
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Indiana/Indianapolis',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    })
    const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]))
    let hour = parts.hour
    if (hour === '24') hour = '00'
    const datePart = `${parts.year}-${parts.month}-${parts.day}`
    return { appointmentDate: datePart, startTime: `${datePart} ${hour}:${parts.minute}:${parts.second}` }
  }
  if (s.includes(' ')) {
    return { appointmentDate: s.split(' ')[0], startTime: s }
  }
  return null
}

async function ghl(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { headers })
    if (r.status !== 429) return r
    const wait = Math.min(8000, 1000 * 2 ** attempt)
    console.warn(`429 on ${url.split('?')[0]} — waiting ${wait}ms`)
    await new Promise(res => setTimeout(res, wait))
  }
  return await fetch(url, { headers })
}

async function main() {
  // Pull team members from Supabase
  const { data: teamMembers, error: tmErr } = await supabase
    .from('team_members')
    .select('id, name, ghl_user_id, role')
    .not('ghl_user_id', 'is', null)
  if (tmErr) { console.error('team_members read failed:', tmErr); process.exit(1) }

  const userIdToCloser = {}
  for (const m of teamMembers || []) {
    if (m.role === 'closer') userIdToCloser[m.ghl_user_id] = m.id
  }
  console.log(`Loaded ${teamMembers.length} team_members (${Object.keys(userIdToCloser).length} closers)`)

  // 60 days back, 30 days forward
  const startMs = Date.now() - 60 * 24 * 60 * 60 * 1000
  const endMs = Date.now() + 30 * 24 * 60 * 60 * 1000

  const eventsByEventId = new Map()

  console.log(`\nFetching events for ${teamMembers.length} team members…`)
  for (const m of teamMembers) {
    const r = await ghl(`${BASE}/calendars/events?locationId=${GHL_LOC}&userId=${encodeURIComponent(m.ghl_user_id)}&startTime=${startMs}&endTime=${endMs}`)
    if (!r.ok) { console.warn(`  ${m.name}: HTTP ${r.status}`); continue }
    const json = await r.json()
    const events = json.events || []
    let added = 0
    for (const e of events) {
      if (e.id && !eventsByEventId.has(e.id)) { eventsByEventId.set(e.id, e); added++ }
      else if (e.id) eventsByEventId.set(e.id, e) // overwrite — userId is source of truth
    }
    console.log(`  ${m.name} (${m.role}): ${events.length} events (${added} new)`)
  }

  const calendars = [...new Set([...INTRO_CALENDARS, ...STRATEGY_CALL_CALENDARS])]
  console.log(`\nFetching events for ${calendars.length} known calendars…`)
  for (const calId of calendars) {
    const r = await ghl(`${BASE}/calendars/events?locationId=${GHL_LOC}&calendarId=${calId}&startTime=${startMs}&endTime=${endMs}`)
    if (!r.ok) { console.warn(`  ${calId}: HTTP ${r.status}`); continue }
    const json = await r.json()
    const events = json.events || []
    let added = 0
    for (const e of events) {
      if (e.id && !eventsByEventId.has(e.id)) { eventsByEventId.set(e.id, e); added++ }
    }
    console.log(`  ${calId}: ${events.length} events (${added} new)`)
  }

  console.log(`\nTotal unique events: ${eventsByEventId.size}`)

  const resolveCloser = (e) => {
    const direct = userIdToCloser[e.assignedUserId]
    if (direct) return { closerId: direct, ghlUserId: e.assignedUserId }
    if (Array.isArray(e.users)) {
      for (const uid of e.users) {
        if (userIdToCloser[uid]) return { closerId: userIdToCloser[uid], ghlUserId: uid }
      }
    }
    return { closerId: null, ghlUserId: e.assignedUserId || '' }
  }

  const rows = []
  for (const e of eventsByEventId.values()) {
    if (e.appointmentStatus === 'cancelled') continue
    const startParsed = parseEventDateTime(e.startTime)
    if (!startParsed) continue
    const endParsed = parseEventDateTime(e.endTime)
    const { closerId, ghlUserId } = resolveCloser(e)
    rows.push({
      ghl_event_id: e.id,
      closer_id: closerId,
      ghl_user_id: ghlUserId,
      contact_name: e.title || 'Unknown',
      contact_email: '',
      contact_phone: '',
      start_time: startParsed.startTime,
      end_time: endParsed?.startTime || null,
      calendar_name: e.calendarId || '',
      appointment_status: e.appointmentStatus || 'confirmed',
      appointment_date: startParsed.appointmentDate,
      ghl_contact_id: e.contactId || '',
      booked_at: e.dateAdded || null,
    })
  }

  console.log(`\nUpserting ${rows.length} non-cancelled rows…`)
  // Chunk to avoid payload limits
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const { error } = await supabase
      .from('ghl_appointments')
      .upsert(slice, { onConflict: 'ghl_event_id' })
    if (error) { console.error('Upsert failed:', error); process.exit(1) }
    console.log(`  ${Math.min(i + CHUNK, rows.length)}/${rows.length} upserted`)
  }

  // Quick verification: count rows per closer for May 4
  console.log(`\n=== May 4 verification (per closer) ===`)
  const closerIds = teamMembers.filter(m => m.role === 'closer').map(m => m.id)
  for (const m of teamMembers.filter(t => t.role === 'closer')) {
    const { count } = await supabase
      .from('ghl_appointments')
      .select('*', { count: 'exact', head: true })
      .eq('appointment_date', '2026-05-04')
      .or(`closer_id.eq.${m.id},ghl_user_id.eq.${m.ghl_user_id}`)
    console.log(`  ${m.name}: ${count} events on May 4`)
  }

  console.log('\nDone.')
}

main().catch(e => { console.error(e); process.exit(1) })
