import { createClient } from '@supabase/supabase-js'
const url = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
const sb = createClient(url, key)

// 1. Search ALL ghl_appointments — every calendar, every status
const names = ['Kelsey','Richard','Brian','George','Jack']
console.log('=== Search ALL ghl_appointments (any calendar, any status, any date) ===\n')
for (const n of names) {
  const { data } = await sb.from('ghl_appointments')
    .select('booked_at, appointment_date, contact_name, calendar_name, appointment_status')
    .ilike('contact_name', `%${n}%`)
    .order('appointment_date', { ascending: false })
    .limit(10)
  if (data?.length) {
    console.log(`"${n}" — ${data.length} match(es):`)
    for (const a of data) {
      console.log(`  booked ${a.booked_at?.slice(0,16) || '-'} → ${a.appointment_date} | cal=${a.calendar_name} | ${a.appointment_status} | ${a.contact_name}`)
    }
  } else {
    console.log(`"${n}" — NO matches anywhere in ghl_appointments`)
  }
}
console.log()

// 2. What's the freshness of ghl_appointments? Latest sync timestamp
const { data: latest } = await sb.from('ghl_appointments')
  .select('booked_at, created_at, updated_at')
  .order('created_at', { ascending: false })
  .limit(5)
console.log('=== 5 most recently CREATED rows in ghl_appointments ===')
for (const r of latest || []) {
  console.log(`  created ${r.created_at} | updated ${r.updated_at} | booked_at ${r.booked_at}`)
}
console.log()

// 3. All distinct calendar_name values (maybe other calendars exist)
const { data: cals } = await sb.from('ghl_appointments')
  .select('calendar_name')
  .gte('appointment_date', '2026-04-01')
const calSet = {}
for (const c of cals || []) calSet[c.calendar_name] = (calSet[c.calendar_name] || 0) + 1
console.log('=== All calendar_names in use since 2026-04-01 ===')
for (const [k, n] of Object.entries(calSet)) console.log(`  ${k}: ${n}`)
console.log()

// 4. Check ghl_leads / opportunities table for these names (lead might exist before booking)
const { data: leads } = await sb.from('ghl_leads')
  .select('contact_name, opportunity_name, status, created_at')
  .or(names.map(n => `contact_name.ilike.%${n}%`).join(','))
  .order('created_at', { ascending: false })
  .limit(20)
console.log('=== Search ghl_leads (lead pipeline) ===')
console.log(`Total: ${leads?.length || 0}`)
for (const l of leads || []) {
  console.log(`  ${l.created_at?.slice(0,10)} | ${l.contact_name} | ${l.status}`)
}
