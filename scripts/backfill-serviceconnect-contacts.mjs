// One-time backfill: populate contact_email / contact_phone on ghl_appointments
// for ServiceConnect prospects, from their GHL contact record. The audience
// resolver (lib_strategy_booking_resolved) matches funnel by email → phone →
// name; the /calendars/events sync never captured email/phone, so these
// bookings couldn't be attributed. Going forward the sync now captures them
// (enrichRowsWithContact in ghlCalendar.js); this fixes the existing rows.
//
// Scope: every appointment row belonging to a contact who has a booking on the
// ServiceConnect Strategy Call calendar (el8rJciCrMWpWiH1ulGc), where email is
// currently empty. Keeps blast radius to ServiceConnect-related prospects.
//
// Usage: node scripts/backfill-serviceconnect-contacts.mjs [--apply]
//   (dry-run by default; pass --apply to write)
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const SC_CAL = 'el8rJciCrMWpWiH1ulGc'

const salesEnv = fs.readFileSync('C:/Users/Ben/sentinel/.env', 'utf8')
const sv = (n) => { const m = salesEnv.match(new RegExp('^' + n + '=(.*)$', 'm')); return m ? m[1].trim() : null }
const dashEnv = fs.readFileSync('C:/Users/Ben/sales-dashboard/.env', 'utf8')
const dv = (n) => { const m = dashEnv.match(new RegExp('^' + n + '=(.*)$', 'm')); return m ? m[1].trim() : null }

const sb = createClient(sv('SUPABASE_SALES_URL') || 'https://kjfaqhmllagbxjdxlopm.supabase.co', sv('SUPABASE_SALES_KEY'))
const GHL_KEY = dv('VITE_GHL_API_KEY')

async function ghlContact(id) {
  let r = await fetch(`https://services.leadconnectorhq.com/contacts/${id}`, { headers: { Authorization: `Bearer ${GHL_KEY}`, Version: '2021-07-28' } })
  if (!r.ok) return null
  const j = await r.json(); const c = j.contact || j
  return { email: c.email || '', phone: c.phone || '' }
}

// 1. Contacts who booked ServiceConnect
const { data: scRows, error: e1 } = await sb.from('ghl_appointments')
  .select('ghl_contact_id').eq('calendar_name', SC_CAL).not('ghl_contact_id', 'is', null)
if (e1) { console.error(e1); process.exit(1) }
const contactIds = [...new Set(scRows.map(r => r.ghl_contact_id).filter(Boolean))]
console.log(`ServiceConnect prospects: ${contactIds.length} unique contacts`)

// 2. All their appointment rows missing an email
const { data: rows } = await sb.from('ghl_appointments')
  .select('id, ghl_event_id, contact_name, calendar_name, contact_email, contact_phone, ghl_contact_id')
  .in('ghl_contact_id', contactIds)
const needing = rows.filter(r => !r.contact_email || !r.contact_email.trim())
console.log(`Rows needing email backfill: ${needing.length} (of ${rows.length} total rows for these contacts)`)
console.log(APPLY ? '\n=== APPLYING ===\n' : '\n=== DRY RUN (pass --apply to write) ===\n')

// 3. Fetch each contact once, update its rows
const cache = {}
let updated = 0, noEmail = 0
for (const cid of contactIds) {
  if (!(cid in cache)) cache[cid] = await ghlContact(cid)
  const c = cache[cid]
  const rs = needing.filter(r => r.ghl_contact_id === cid)
  if (!rs.length) continue
  if (!c || (!c.email && !c.phone)) { noEmail += rs.length; continue }
  const name = (rs[0].contact_name || '').split(' - ')[0]
  console.log(`  ${name.padEnd(22)} → ${c.email || '∅'} / ${c.phone || '∅'}  (${rs.length} row${rs.length>1?'s':''})`)
  if (APPLY) {
    const { error } = await sb.from('ghl_appointments')
      .update({ contact_email: c.email, contact_phone: c.phone })
      .in('id', rs.map(r => r.id))
    if (error) console.log(`    ERR: ${error.message}`)
    else updated += rs.length
  }
}
console.log(`\n${APPLY ? 'Updated' : 'Would update'} rows: ${APPLY ? updated : needing.length - noEmail}; no GHL email/phone: ${noEmail}`)
