// Diagnose why leads (22) is less than qualified_bookings (25).
// 1) List all GHL pipelines
// 2) Per pipeline, count opportunities created in the last 30 days
// 3) Cross-reference: for each strategy-booked contact, do they have an opportunity?

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

const STRAT = ['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0','gohFzPCilzwBtVfaC6fu']
const SCIO_PIPELINE = 'ZN1DW9S9qS540PNAXSxa'
const SINCE = (() => { const s = new Date(); s.setDate(s.getDate() - 30); return s.toISOString().split('T')[0] })()

// 1) List all pipelines
console.log('=== GHL PIPELINES ===')
const pRes = await fetch(`${BASE}/opportunities/pipelines?locationId=${LOC}`, { headers })
const { pipelines = [] } = await pRes.json()
for (const p of pipelines) {
  console.log(`  ${p.id}  ${p.name}  (${(p.stages || []).length} stages)`)
}

// 2) Per pipeline, count opps created since SINCE
console.log(`\n=== Opportunities created since ${SINCE} per pipeline ===`)
async function countOppsSince(pipelineId) {
  let count = 0, all = []
  let startAfterId = null, startAfter = null
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({ location_id: LOC, pipeline_id: pipelineId, limit: '100' })
    if (startAfterId) { params.set('startAfterId', startAfterId); params.set('startAfter', String(startAfter)) }
    const r = await fetch(`${BASE}/opportunities/search?${params}`, { headers })
    if (!r.ok) return { count, all, err: `HTTP ${r.status}` }
    const j = await r.json()
    const opps = j.opportunities || []
    all = all.concat(opps)
    for (const o of opps) {
      const d = (o.createdAt || '').split('T')[0]
      if (d && d >= SINCE) count++
    }
    if (!j.meta?.startAfterId || opps.length === 0) break
    startAfterId = j.meta.startAfterId
    startAfter = j.meta.startAfter
  }
  return { count, all }
}

const oppsByPipeline = {}
for (const p of pipelines) {
  const { count, all } = await countOppsSince(p.id)
  oppsByPipeline[p.id] = all
  console.log(`  ${p.id.slice(0, 8)}  ${p.name.padEnd(40)}  total=${all.length}  since=${count}`)
}

// 3) For strategy-booked contacts, check if they have an opportunity in any pipeline
console.log(`\n=== Strategy-booked contacts vs opportunity coverage (${SINCE}+) ===`)
const { data: stratAppts } = await supabase
  .from('ghl_appointments')
  .select('appointment_date, ghl_contact_id, contact_name, calendar_name')
  .gte('appointment_date', SINCE)
  .neq('appointment_status', 'cancelled')
  .in('calendar_name', STRAT)

const allContactsWithOpps = new Set()
const oppsByContactPipeline = {}
for (const [pid, opps] of Object.entries(oppsByPipeline)) {
  for (const o of opps) {
    const cid = o.contact?.id || o.contactId
    if (cid) {
      allContactsWithOpps.add(cid)
      const key = `${cid}|${pid}`
      oppsByContactPipeline[key] = o
    }
  }
}

let withScio = 0, withOtherOnly = 0, withNothing = 0
const noOppExamples = []
for (const a of stratAppts || []) {
  if (!a.ghl_contact_id) continue
  const hasScio = oppsByContactPipeline[`${a.ghl_contact_id}|${SCIO_PIPELINE}`] !== undefined
  const hasAny = allContactsWithOpps.has(a.ghl_contact_id)
  if (hasScio) withScio++
  else if (hasAny) {
    withOtherOnly++
    // Find which pipeline they're in
    const otherPipes = Object.keys(oppsByPipeline).filter(pid => pid !== SCIO_PIPELINE && oppsByContactPipeline[`${a.ghl_contact_id}|${pid}`])
    if (noOppExamples.length < 5) noOppExamples.push(`${a.contact_name} → ${otherPipes.map(p => pipelines.find(pp => pp.id === p)?.name).join(', ')}`)
  } else {
    withNothing++
    if (noOppExamples.length < 5) noOppExamples.push(`${a.contact_name} → NO opportunity in any pipeline`)
  }
}

console.log(`Total strategy-booked contacts: ${stratAppts?.length || 0}`)
console.log(`  In SCIO pipeline:           ${withScio}`)
console.log(`  In OTHER pipeline only:     ${withOtherOnly}`)
console.log(`  No opportunity at all:      ${withNothing}`)
console.log(`\nExamples of non-SCIO bookings:`)
for (const ex of noOppExamples) console.log(`  - ${ex}`)
