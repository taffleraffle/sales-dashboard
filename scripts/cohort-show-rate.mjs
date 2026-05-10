import { createClient } from '@supabase/supabase-js'
const url = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
const sb = createClient(url, key)

const QUALIFIED = ['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0']

const since = '2026-04-28'
const today = '2026-05-05'

// Pull every status — see what's actually on the calendar in this window
const { data: appts } = await sb.from('ghl_appointments')
  .select('appointment_date, booked_at, appointment_status, calendar_name, contact_name')
  .gte('appointment_date', since)
  .lte('appointment_date', today)
  .in('calendar_name', QUALIFIED)
  .order('appointment_date', { ascending: true })

console.log(`Qualified calls scheduled (any status) ${since} → ${today}: ${appts?.length}\n`)
const byStatus = {}
for (const a of appts || []) {
  byStatus[a.appointment_status] = (byStatus[a.appointment_status] || 0) + 1
}
console.log('Status breakdown:', JSON.stringify(byStatus, null, 2))
console.log()

console.log('All scheduled calls:')
for (const a of appts || []) {
  console.log(`  ${a.appointment_date} | ${a.appointment_status?.padEnd(11)} | ${a.contact_name}`)
}
console.log()

// EOD-side reschedules + cancels
const { data: eod } = await sb.from('closer_eod_reports')
  .select('report_date, live_nc_calls, live_fu_calls, nc_no_shows, fu_no_shows, reschedules, nc_cancels, fu_cancels')
  .gte('report_date', since)
  .lte('report_date', today)

let nc_live=0, fu_live=0, no_shows=0, reschedules=0, cancels=0
for (const r of eod || []) {
  nc_live += r.live_nc_calls || 0
  fu_live += r.live_fu_calls || 0
  no_shows += (r.nc_no_shows || 0) + (r.fu_no_shows || 0)
  reschedules += r.reschedules || 0
  cancels += (r.nc_cancels || 0) + (r.fu_cancels || 0)
}
console.log(`EOD totals (window): live_nc=${nc_live}, live_fu=${fu_live}, no_shows=${no_shows}, reschedules=${reschedules}, cancels=${cancels}`)
console.log()

const totalCalendar = appts?.length || 0
const denomGross = totalCalendar
const denomNet = totalCalendar - reschedules - cancels

console.log(`=== Cohort Show Rate (NC live ÷ qualified scheduled) ===`)
console.log(`Gross (no exclusions):  ${nc_live} / ${denomGross} = ${((nc_live/denomGross)*100).toFixed(1)}%`)
console.log(`Net (− reschedules − cancels):  ${nc_live} / ${denomNet} = ${((nc_live/denomNet)*100).toFixed(1)}%`)
