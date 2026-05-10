import { createClient } from '@supabase/supabase-js'
const url = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
const sb = createClient(url, key)

const STRATEGY = ['cEyqCFAsPLDkUV8n982h','9yoQVPBkNX4tWYmcDkf3','T5Zif5GjDwulya6novU0','gohFzPCilzwBtVfaC6fu']

const { data: appts } = await sb.from('ghl_appointments')
  .select('booked_at, appointment_date, appointment_status')
  .in('calendar_name', STRATEGY)
  .neq('appointment_status', 'cancelled')
  .gte('booked_at', '2026-04-01')

const today = '2026-05-05'

let bookedAtCount = {}
let apptDateCount = {}
let futureLeak = 0
let bookedToday = 0
let bookedTodayForFuture = 0

for (const a of appts || []) {
  const bd = (a.booked_at || '').split(/[ T]/)[0]
  const ad = (a.appointment_date || '').split(/[ T]/)[0]
  if (bd) bookedAtCount[bd] = (bookedAtCount[bd] || 0) + 1
  if (ad) apptDateCount[ad] = (apptDateCount[ad] || 0) + 1
  if (bd && ad && bd <= today && ad > today) futureLeak++
  if (bd === today) {
    bookedToday++
    if (ad > today) bookedTodayForFuture++
  }
}

console.log(`Total strategy bookings since 2026-04-01: ${appts?.length}`)
console.log(`Bookings made on or before ${today} that are FOR a future call: ${futureLeak}`)
console.log(`These are sitting in qualified_bookings but their live call hasn't happened yet`)
console.log()
console.log(`Bookings booked TODAY (${today}): ${bookedToday}`)
console.log(`  ...for calls in the future: ${bookedTodayForFuture}`)
console.log(`  ...for today: ${bookedToday - bookedTodayForFuture}`)
console.log()

// Last 7 days of qualified_bookings vs new_live_calls
const since = '2026-04-28'
let qb7 = 0
for (const [d, n] of Object.entries(bookedAtCount)) if (d >= since && d <= today) qb7 += n

const { data: eod } = await sb.from('closer_eod_reports')
  .select('report_date, live_nc_calls')
  .gte('report_date', since)
let nlc7 = 0
for (const r of eod || []) nlc7 += r.live_nc_calls || 0

console.log(`=== Last 7 days (${since} → ${today}) ===`)
console.log(`qualified_bookings (booked_at-bucketed): ${qb7}`)
console.log(`new_live_calls (report_date-bucketed): ${nlc7}`)
console.log(`Reported show rate: ${((nlc7 / qb7) * 100).toFixed(1)}%`)
console.log()

// Apples-to-apples: bookings whose appointment_date is in the same window
let qb7_byAppt = 0
for (const [d, n] of Object.entries(apptDateCount)) if (d >= since && d <= today) qb7_byAppt += n
console.log(`If qualified_bookings were bucketed by appointment_date instead:`)
console.log(`qualified_bookings (appointment_date-bucketed): ${qb7_byAppt}`)
console.log(`Apples-to-apples show rate: ${((nlc7 / qb7_byAppt) * 100).toFixed(1)}%`)
console.log()

// Bookings made in window but call is AFTER window
let bookedInWindowFutureCall = 0
for (const a of appts || []) {
  const bd = (a.booked_at || '').split(/[ T]/)[0]
  const ad = (a.appointment_date || '').split(/[ T]/)[0]
  if (bd >= since && bd <= today && ad > today) bookedInWindowFutureCall++
}
console.log(`Bookings made in last 7d whose call is AFTER ${today}: ${bookedInWindowFutureCall}`)
console.log(`These are in the denominator but CAN'T have a live call yet`)
