import { createClient } from '@supabase/supabase-js'
const url = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
const sb = createClient(url, key)

// Search team_members ignoring is_active
const { data: allMembers } = await sb.from('team_members').select('*').order('name')
console.log('=== All team_members (active + inactive) ===')
for (const m of allMembers || []) {
  console.log(`  ${(m.name || 'Unnamed').padEnd(20)} role=${(m.role || '').padEnd(8)} active=${m.is_active}  email=${m.email || '-'}`)
}
console.log()

// Search for the specific names Ben mentioned
const names = ['kelsey','richard','brian','jon','sihom','sihem','siham']
console.log('=== Search for names mentioned ===')
for (const n of names) {
  const { data } = await sb.from('team_members').select('name, role, is_active, email').ilike('name', `%${n}%`)
  console.log(`  "${n}": ${data?.length ? JSON.stringify(data) : 'NOT FOUND in team_members'}`)
}
console.log()

// Look at recent closer_eod_reports — maybe other closer_ids appear that aren't joined
const { data: recentEod } = await sb.from('closer_eod_reports')
  .select('closer_id, report_date, closer:team_members!closer_eod_reports_closer_id_fkey(name)')
  .gte('report_date', '2026-04-01')
const idSet = new Set()
for (const r of recentEod || []) idSet.add(`${r.closer?.name || 'UNKNOWN'} (${r.closer_id})`)
console.log('=== Distinct closers with EOD reports since 2026-04-01 ===')
for (const id of idSet) console.log(`  ${id}`)
console.log()

// Check ghl_appointments for unique closer names / assigned_user
const { data: appts } = await sb.from('ghl_appointments')
  .select('closer_id, closer:team_members!ghl_appointments_closer_id_fkey(name)')
  .gte('appointment_date', '2026-04-01')
const apptIds = new Map()
for (const a of appts || []) {
  const k = a.closer?.name || `null/${a.closer_id || 'unassigned'}`
  apptIds.set(k, (apptIds.get(k) || 0) + 1)
}
console.log('=== Closers in ghl_appointments since 2026-04-01 ===')
for (const [k, n] of apptIds) console.log(`  ${k}: ${n} appointments`)
