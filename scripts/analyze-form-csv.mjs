// Read the Typeform CSV the user pointed at, summarize it, and cross-reference
// against marketing_tracker.leads + ghl_appointments for the same window.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

const CSV_PATH = 'C:/Users/Ben/Downloads/responses-h4il4Sla-01KQTHGAWMABF97MFPGZTWP67G-NW08C5R2MMCMMD0FKU8YXJJH.csv'
const raw = readFileSync(CSV_PATH, 'utf8')

// Tiny CSV parser (handles quoted fields with commas + embedded newlines + escaped quotes).
function parseCSV(s) {
  const rows = []
  let row = [], cell = '', i = 0, inQuotes = false
  while (i < s.length) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i += 2; continue }
      if (c === '"') { inQuotes = false; i++; continue }
      cell += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(cell); cell = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue }
    cell += c; i++
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row) }
  return rows
}

const rows = parseCSV(raw)
const header = rows[0]
const data = rows.slice(1).filter(r => r.some(c => c && c.trim()))
console.log(`CSV rows: ${data.length}\n`)

// Print headers so we know what we're working with
console.log('=== Columns ===')
header.forEach((h, i) => console.log(`  [${i}] ${(h || '').replace(/\s+/g, ' ').slice(0, 80)}`))

// Find a few key columns by name
const idx = (needle) => header.findIndex(h => (h || '').toLowerCase().includes(needle.toLowerCase()))
const colSubmit = idx('submit')
const colEnding = idx('ending')
const colResp = idx('response type')
const colName = header.findIndex(h => /name/i.test(h || ''))
const colEmail = header.findIndex(h => /email/i.test(h || ''))
const colCalendlyURL = header.findIndex(h => /calendly|booking link/i.test(h || ''))
console.log(`\n=== Key indexes ===\nsubmit=${colSubmit}  ending=${colEnding}  resp_type=${colResp}  name=${colName}  email=${colEmail}  calendly=${colCalendlyURL}`)

// Last 7 days window — both UTC and NZ-local for safety
const now = new Date()
const sevenAgoUTC = new Date(now.getTime() - 7 * 86400000).toISOString().split('T')[0]
const todayUTC = now.toISOString().split('T')[0]

console.log(`\n=== Last 7d window (UTC): ${sevenAgoUTC} → ${todayUTC} ===`)
let total = 0, byEnding = {}, byRespType = {}, withCalendly = 0
for (const r of data) {
  const submit = (r[colSubmit] || '').slice(0, 10)
  if (submit < sevenAgoUTC || submit > todayUTC) continue
  total++
  const ending = (r[colEnding] || '').trim()
  byEnding[ending || '(none)'] = (byEnding[ending || '(none)'] || 0) + 1
  const respType = (r[colResp] || '').trim()
  byRespType[respType || '(none)'] = (byRespType[respType || '(none)'] || 0) + 1
  if ((r[colCalendlyURL] || '').includes('calendly')) withCalendly++
}
console.log(`Total form rows in 7d:  ${total}`)
console.log(`  by Response Type:`)
for (const [k, v] of Object.entries(byRespType)) console.log(`    ${k}: ${v}`)
console.log(`  by Ending:`)
for (const [k, v] of Object.entries(byEnding)) console.log(`    ${k}: ${v}`)
console.log(`  with Calendly URL captured: ${withCalendly}`)

// Cross-reference: how many of these emails appear in opportunities + ghl_appointments?
const emails = new Set()
for (const r of data) {
  const submit = (r[colSubmit] || '').slice(0, 10)
  if (submit < sevenAgoUTC) continue
  const e = (r[colEmail] || '').trim().toLowerCase()
  if (e) emails.add(e)
}
console.log(`\nUnique emails in 7d form responses: ${emails.size}`)

// Marketing tracker leads in the same window
const { data: mt } = await supabase
  .from('marketing_tracker')
  .select('date, leads, qualified_bookings')
  .gte('date', sevenAgoUTC)
  .lte('date', todayUTC)
const totLeads = (mt || []).reduce((s, r) => s + (r.leads || 0), 0)
const totQ = (mt || []).reduce((s, r) => s + (r.qualified_bookings || 0), 0)
console.log(`\nmarketing_tracker totals (same window):  leads=${totLeads}  qualified_bookings=${totQ}`)
