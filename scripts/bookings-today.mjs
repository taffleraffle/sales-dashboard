import { createClient } from '@supabase/supabase-js'
const url = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
const sb = createClient(url, key)

const QUALIFIED = ['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0']

console.log('Today: 2026-05-05 (Tuesday)\n')

// All bookings booked today (regardless of when they happen)
const { data: bookedToday } = await sb.from('ghl_appointments')
  .select('booked_at, appointment_date, contact_name, calendar_name, appointment_status')
  .gte('booked_at', '2026-05-05T00:00:00')
  .lt('booked_at', '2026-05-06T00:00:00')
  .order('appointment_date')
console.log(`=== Bookings made TODAY (booked_at = 2026-05-05) ===`)
console.log(`Total: ${bookedToday?.length || 0}`)
for (const b of bookedToday || []) {
  const isQ = QUALIFIED.includes(b.calendar_name) ? 'QUAL' : 'DQ/intro'
  console.log(`  ${b.booked_at} → call ${b.appointment_date} | ${isQ} | ${b.appointment_status} | ${b.contact_name}`)
}
console.log()

// Last 24h of bookings
const { data: last24 } = await sb.from('ghl_appointments')
  .select('booked_at, appointment_date, contact_name, calendar_name, appointment_status, created_at')
  .gte('booked_at', '2026-05-04T00:00:00')
  .order('booked_at', { ascending: false })
  .limit(50)
console.log(`=== All bookings since yesterday morning (last 24-36h) ===`)
console.log(`Total: ${last24?.length || 0}`)
for (const b of last24 || []) {
  const isQ = QUALIFIED.includes(b.calendar_name) ? 'QUAL' : (b.calendar_name === 'gohFzPCilzwBtVfaC6fu' ? 'DQ' : 'OTHER')
  console.log(`  booked ${b.booked_at?.slice(0,16)} → call ${b.appointment_date} | ${isQ} | ${b.appointment_status} | ${b.contact_name}`)
}
console.log()

// Future-scheduled bookings (Wed/Thu/Fri this week)
const { data: futureCalls } = await sb.from('ghl_appointments')
  .select('booked_at, appointment_date, contact_name, calendar_name, appointment_status')
  .gte('appointment_date', '2026-05-06')
  .lte('appointment_date', '2026-05-09')
  .order('appointment_date')
console.log(`=== Calls scheduled Wed-Fri this week (May 6-9) ===`)
for (const b of futureCalls || []) {
  const isQ = QUALIFIED.includes(b.calendar_name) ? 'QUAL' : (b.calendar_name === 'gohFzPCilzwBtVfaC6fu' ? 'DQ' : 'OTHER')
  console.log(`  booked ${b.booked_at?.slice(0,16) || '(no booked_at)'} → call ${b.appointment_date} | ${isQ} | ${b.appointment_status} | ${b.contact_name}`)
}
console.log()

// What does the marketing_tracker actually show for last 7d?
const { data: tracker } = await sb.from('marketing_tracker')
  .select('date, adspend, leads, qualified_bookings, calls_on_calendar, new_live_calls')
  .gte('date', '2026-04-28')
  .lte('date', '2026-05-05')
  .order('date')
console.log(`=== marketing_tracker rows (what dashboard reads) ===`)
console.table(tracker)

// Look for Kelsey/Richard/Brian/George/Jack/John specifically
console.log(`\n=== Searching by name ===`)
const names = ['Kelsey','Richard','Brian','George','Jack','John']
for (const n of names) {
  const { data } = await sb.from('ghl_appointments')
    .select('booked_at, appointment_date, contact_name, calendar_name, appointment_status')
    .ilike('contact_name', `%${n}%`)
    .gte('appointment_date', '2026-05-05')
    .order('appointment_date')
  if (data?.length) {
    console.log(`  "${n}":`)
    for (const a of data) {
      const isQ = QUALIFIED.includes(a.calendar_name) ? 'QUAL' : (a.calendar_name === 'gohFzPCilzwBtVfaC6fu' ? 'DQ' : 'OTHER')
      console.log(`    booked ${a.booked_at?.slice(0,16)} → ${a.appointment_date} | ${isQ} | ${a.appointment_status} | ${a.contact_name}`)
    }
  } else {
    console.log(`  "${n}": no bookings scheduled today or after`)
  }
}
