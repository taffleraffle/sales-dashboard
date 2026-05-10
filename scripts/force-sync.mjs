// Direct GHL sync — bypasses the UI hourly interval check.
// Hits /calendars/events for the future window, upserts into ghl_appointments.
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'

// Read .env manually (no dotenv)
const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] })
)

const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_KEY = env.VITE_SUPABASE_ANON_KEY
const GHL_API_KEY = env.VITE_GHL_API_KEY
const GHL_LOCATION_ID = env.VITE_GHL_LOCATION_ID
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const BASE = 'https://services.leadconnectorhq.com'
const headers = { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' }

// Pull team_members for user IDs to query per-user
const { data: members } = await sb.from('team_members').select('id, name, ghl_user_id, role').not('ghl_user_id', 'is', null)
console.log('Team members with ghl_user_id:', members?.map(m => `${m.name} (${m.role}) ${m.ghl_user_id}`).join(', '))

// All known calendar IDs to scan
const STRATEGY = ['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0','gohFzPCilzwBtVfaC6fu']
const INTRO = ['5omixNmtgmGMWQfEL0fs','C5NRRAjwsy43nOyU6izQ','GpYh75LaFEJgpHYkZfN9','okWMyvLhnJ7sbuvSIzok','MvYStrHFsRTpunwTXIqT']
const ALL = [...STRATEGY, ...INTRO]

// Query window: -30d to +90d
const start = new Date(); start.setDate(start.getDate() - 30)
const end = new Date(); end.setDate(end.getDate() + 90)
const startMs = start.getTime()
const endMs = end.getTime()
console.log(`Window: ${start.toISOString().slice(0,10)} → ${end.toISOString().slice(0,10)}`)

const eventsById = new Map()

// Per-user fetches first (catches Calendly round-robin where calendar_id query misses some)
for (const m of members || []) {
  const url = `${BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&userId=${m.ghl_user_id}&startTime=${startMs}&endTime=${endMs}`
  const r = await fetch(url, { headers })
  if (!r.ok) { console.warn(`  user ${m.name}: HTTP ${r.status}`); continue }
  const j = await r.json()
  console.log(`  user ${m.name}: ${j.events?.length || 0} events`)
  for (const e of j.events || []) eventsById.set(e.id, e)
}

// Per-calendar fetches
for (const cal of ALL) {
  const url = `${BASE}/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${cal}&startTime=${startMs}&endTime=${endMs}`
  const r = await fetch(url, { headers })
  if (!r.ok) { console.warn(`  cal ${cal}: HTTP ${r.status}`); continue }
  const j = await r.json()
  const fresh = (j.events || []).filter(e => !eventsById.has(e.id))
  console.log(`  cal ${cal}: ${j.events?.length || 0} events (${fresh.length} new)`)
  for (const e of j.events || []) if (!eventsById.has(e.id)) eventsById.set(e.id, e)
}

console.log(`\nTotal unique events found: ${eventsById.size}\n`)

// Search for the names Ben is looking for
const targets = ['Kelsey','Brian','Richard','Jon','George Sidhom','Jack','John','Ignite','Pro Restoration','Carolina Water','Aqua Flame']
console.log('=== Target prospects in fetched events ===')
for (const t of targets) {
  const matches = [...eventsById.values()].filter(e => (e.title || '').toLowerCase().includes(t.toLowerCase()))
  if (matches.length) {
    console.log(`"${t}":`)
    for (const m of matches) {
      console.log(`  ${m.startTime} | cal=${m.calendarId} | "${m.title}" | status=${m.appointmentStatus} | dateAdded=${m.dateAdded}`)
    }
  } else {
    console.log(`"${t}": not in GHL response`)
  }
}
