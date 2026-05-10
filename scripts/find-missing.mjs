import { createClient } from '@supabase/supabase-js'
const url = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
const sb = createClient(url, key)

const emails = ['ignitesystems3@gmail.com', 'jack@prorestorationca.com', 'callcarolinawater@gmail.com', 'info@aquaflamerestoresit.com']
const nameSeeds = ['ignite','jack','carolina','aqua','kelsey','brian','richard','jon','george','john']

// 1. Check ghl_appointments columns first
const { data: sample } = await sb.from('ghl_appointments').select('*').limit(1)
console.log('ghl_appointments columns:', sample?.[0] ? Object.keys(sample[0]).join(', ') : 'no rows')
console.log()

// 2. Search ghl_appointments by every email field that might exist
console.log('=== Search ghl_appointments by contact_name fragments ===')
for (const seed of nameSeeds) {
  const { data } = await sb.from('ghl_appointments')
    .select('contact_name, ghl_contact_id, booked_at, appointment_date, calendar_name, appointment_status')
    .ilike('contact_name', `%${seed}%`)
    .gte('appointment_date', '2026-05-01')
    .order('appointment_date')
    .limit(10)
  if (data?.length) {
    console.log(`"${seed}": ${data.length} match(es)`)
    for (const a of data) console.log(`  ${a.appointment_date} | ${a.calendar_name} | ${a.contact_name}`)
  }
}
console.log()

// 3. Check ghl_contacts / contacts table?
const tables = ['ghl_contacts','contacts','ghl_opportunities','opportunities','ghl_leads']
for (const t of tables) {
  const { data, error } = await sb.from(t).select('*').limit(1)
  if (!error && data) {
    console.log(`Table "${t}" exists. Columns:`, Object.keys(data[0] || {}).join(', '))
  }
}
console.log()

// 4. Try email search across discovered tables
console.log('=== Email search ===')
for (const email of emails) {
  for (const t of ['ghl_contacts']) {
    const { data, error } = await sb.from(t).select('*').eq('email', email).limit(5)
    if (!error && data?.length) console.log(`${t} email=${email}:`, JSON.stringify(data, null, 2))
  }
}
console.log()

// 5. Latest appointment_date in db (to confirm sync hasn't pulled future yet)
const { data: latestApt } = await sb.from('ghl_appointments')
  .select('appointment_date, contact_name, booked_at')
  .order('appointment_date', { ascending: false })
  .limit(10)
console.log('=== Top 10 latest appointment_dates in DB ===')
for (const a of latestApt || []) console.log(`  ${a.appointment_date} | ${a.contact_name}`)
