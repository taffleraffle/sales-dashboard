// Cross-ref CSV emails against GHL contacts and SCIO opportunities to find
// the leads that submitted the form but didn't make it into our SCIO count.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

const BASE = 'https://services.leadconnectorhq.com'
const ghlHeaders = { Authorization: `Bearer ${env.VITE_GHL_API_KEY}`, Version: '2021-07-28' }
const LOC = env.VITE_GHL_LOCATION_ID
const SCIO_USA = 'ZN1DW9S9qS540PNAXSxa'

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
const todayUTC = new Date().toISOString().split('T')[0]

// Form rows in last 7 days, with email + ending + revenue
const formRows = []
for (const r of data) {
  const submit = (r[25] || '').slice(0, 10)
  if (submit < sevenAgoUTC || submit > todayUTC) continue
  formRows.push({
    submit,
    name: r[4],
    email: (r[6] || '').trim().toLowerCase(),
    revenue: r[8],
    franchise: r[2],
    franchiseAccess: r[3],
    ending: r[28],
    bookingLink30k: r[10],
    bookingLinkDQ: r[11],
  })
}
console.log(`Form rows in 7d: ${formRows.length}`)

// Pull all SCIO USA opportunities
let allOpps = []
let startAfterId = null, startAfter = null
for (let p = 0; p < 50; p++) {
  const params = new URLSearchParams({ location_id: LOC, pipeline_id: SCIO_USA, limit: '100' })
  if (startAfterId) { params.set('startAfterId', startAfterId); params.set('startAfter', String(startAfter)) }
  const r = await fetch(`${BASE}/opportunities/search?${params}`, { headers: ghlHeaders })
  if (!r.ok) break
  const j = await r.json()
  allOpps = allOpps.concat(j.opportunities || [])
  if (!j.meta?.startAfterId || (j.opportunities || []).length === 0) break
  startAfterId = j.meta.startAfterId; startAfter = j.meta.startAfter
}

const scioByEmail = {}
const scio7d = []
for (const o of allOpps) {
  const e = (o.contact?.email || '').trim().toLowerCase()
  if (e) scioByEmail[e] = o
  const cd = (o.createdAt || '').split('T')[0]
  if (cd >= sevenAgoUTC && cd <= todayUTC) scio7d.push({ name: o.contact?.name, email: e, createdAt: o.createdAt, stage: o.pipelineStageId })
}
console.log(`SCIO USA opportunities created in last 7d: ${scio7d.length}`)
console.log(`SCIO USA opportunities total: ${allOpps.length}\n`)

// Who's in form but NOT in SCIO (any time)?
console.log('=== FORM rows whose email has NO opportunity in SCIO USA ===\n')
let missing = 0, dqMissing = 0
for (const f of formRows) {
  if (!f.email) { console.log(`  (no email) ${f.name} — ending=${f.ending}`); continue }
  if (!scioByEmail[f.email]) {
    missing++
    if (f.ending === 'DQ Page') dqMissing++
    console.log(`  ${f.email}  name="${f.name}"  rev="${f.revenue}"  ending="${f.ending}"`)
  }
}
console.log(`\nMissing total: ${missing}  (of which ${dqMissing} are DQ Page hits, expected to be missing)`)
console.log(`Net unaccounted for (qualified-on-revenue but missing from SCIO): ${missing - dqMissing}`)

// Who's in SCIO 7d but NOT in form?
console.log('\n=== SCIO opps created in 7d whose email is NOT in the form ===\n')
const formEmails = new Set(formRows.map(f => f.email).filter(Boolean))
let sourcedElsewhere = 0
for (const o of scio7d) {
  if (!o.email || !formEmails.has(o.email)) {
    sourcedElsewhere++
    console.log(`  ${o.email || '(no email)'}  "${o.name}"  created=${o.createdAt?.slice(0,10)}`)
  }
}
console.log(`\nSCIO opps NOT from this form (sourced elsewhere): ${sourcedElsewhere}`)
