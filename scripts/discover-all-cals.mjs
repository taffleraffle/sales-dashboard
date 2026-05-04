// Find every GHL calendar that has events in the last 60 days, including
// hidden round-robin calendars that don't appear in /calendars/?locationId=.
// Surfaces them by querying events per team-member userId, then collecting
// the unique calendarIds and looking up each one's metadata.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const BASE = 'https://services.leadconnectorhq.com'
const KEY = env.VITE_GHL_API_KEY
const LOC = env.VITE_GHL_LOCATION_ID
const headers = { Authorization: `Bearer ${KEY}`, Version: '2021-07-28' }
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

// 1) Visible calendars
const visRes = await fetch(`${BASE}/calendars/?locationId=${LOC}`, { headers })
const { calendars: visible = [] } = await visRes.json()
const visibleIds = new Set(visible.map(c => c.id))
console.log(`\n=== ${visible.length} VISIBLE calendars ===`)

// 2) Get all team member ghl_user_ids from Supabase
const { data: members } = await supabase
  .from('team_members')
  .select('name, ghl_user_id')
  .not('ghl_user_id', 'is', null)

// 3) Query events for each user — collect unique calendarIds
const start = Date.now() - 60 * 24 * 60 * 60 * 1000
const end = Date.now() + 30 * 24 * 60 * 60 * 1000
const allCalIds = new Set(visibleIds)
const calIdToCount = {}
for (const m of members || []) {
  const r = await fetch(`${BASE}/calendars/events?locationId=${LOC}&userId=${m.ghl_user_id}&startTime=${start}&endTime=${end}`, { headers })
  if (!r.ok) continue
  const j = await r.json()
  for (const e of (j.events || [])) {
    if (e.calendarId) {
      allCalIds.add(e.calendarId)
      calIdToCount[e.calendarId] = (calIdToCount[e.calendarId] || 0) + 1
    }
  }
}

const hiddenIds = [...allCalIds].filter(id => !visibleIds.has(id))
console.log(`\n=== ${hiddenIds.length} HIDDEN calendars (not in /calendars/, but appear in user events) ===`)

// 4) Look up metadata for each hidden calendar
const allCalsMeta = []
for (const c of visible) allCalsMeta.push({ ...c, hidden: false, eventCount: calIdToCount[c.id] || 0 })
for (const id of hiddenIds) {
  const r = await fetch(`${BASE}/calendars/${id}`, { headers })
  if (r.ok) {
    const j = await r.json()
    const cal = j.calendar || j
    allCalsMeta.push({ id, name: cal.name, calendarType: cal.calendarType, hidden: true, eventCount: calIdToCount[id] || 0 })
  } else {
    allCalsMeta.push({ id, name: '(unknown)', hidden: true, eventCount: calIdToCount[id] || 0 })
  }
}

// 5) Report — sorted by event count desc, with DQ flagged
allCalsMeta.sort((a, b) => (b.eventCount || 0) - (a.eventCount || 0))
console.log(`\n=== ALL CALENDARS BY ACTIVITY ===\n`)
console.log(`hidden  events  id                       name`)
console.log(`------  ------  -----------------------  -----`)
for (const c of allCalsMeta) {
  const isDq = /\bdq\b|disqual|reject|deprior/i.test(c.name || '')
  const flag = isDq ? '  ← DQ?' : ''
  console.log(`${c.hidden ? '  yes ' : '  no  '}  ${String(c.eventCount).padStart(6)}  ${c.id.padEnd(24)} ${c.name}${flag}`)
}
