// Resolve a single GHL calendar ID + list every calendar in the location.
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

const TARGET = 'T5Zif5GjDwulya6novU0'

// Direct calendar fetch
const direct = await fetch(`${BASE}/calendars/${TARGET}`, { headers })
const directJson = await direct.json().catch(() => ({}))
console.log(`\n=== DIRECT FETCH /calendars/${TARGET} (status ${direct.status}) ===`)
console.log(JSON.stringify(directJson, null, 2).slice(0, 1500))

// Try a stage stage ID -> name
const STAGE = '0a2ea6d0-6ddf-49ff-972c-45658e8d7e13'
const PIPE = 'ZN1DW9S9qS540PNAXSxa'
const pipes = await fetch(`${BASE}/opportunities/pipelines?locationId=${LOC}`, { headers })
const pj = await pipes.json().catch(() => ({}))
console.log(`\n=== PIPELINE ${PIPE} STAGES ===`)
const sciopipe = (pj.pipelines || []).find(p => p.id === PIPE)
if (sciopipe) {
  for (const st of sciopipe.stages || []) {
    const marker = st.id === STAGE ? '  ⟵ JOE IS HERE' : ''
    console.log(`  ${st.id}  →  ${st.name}${marker}`)
  }
} else {
  console.log('  Pipeline not found')
}

// Full calendars list for context
const all = await fetch(`${BASE}/calendars/?locationId=${LOC}`, { headers })
const allJson = await all.json().catch(() => ({}))
console.log(`\n=== ALL CALENDARS IN LOCATION (${(allJson.calendars||[]).length} total) ===`)
for (const c of (allJson.calendars || [])) {
  const flag = /strategy/i.test(c.name) ? ' [STRATEGY]' : /intro/i.test(c.name) ? ' [INTRO]' : ''
  console.log(`  ${c.id}  →  ${c.name}${flag}`)
}
