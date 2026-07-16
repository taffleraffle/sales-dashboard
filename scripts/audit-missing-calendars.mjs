import { createClient } from '@supabase/supabase-js'
const url = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
const sb = createClient(url, key)

// The SQL strategy_calendars allowlist (migration 130) + intro calendars (constants.js)
const STRATEGY = new Set(['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0','gohFzPCilzwBtVfaC6fu','woLoGzGKe5fPKZU1jxY7'])
const INTRO = new Set(['5omixNmtgmGMWQfEL0fs','C5NRRAjwsy43nOyU6izQ','GpYh75LaFEJgpHYkZfN9','okWMyvLhnJ7sbuvSIzok','MvYStrHFsRTpunwTXIqT'])

// Pull last 120 days of appointments, group by calendar_name
const since = new Date(); since.setDate(since.getDate() - 120)
const { data, error } = await sb.from('ghl_appointments')
  .select('calendar_name, contact_name, booked_at')
  .gte('booked_at', since.toISOString())
if (error) { console.log('ERR', error.message); process.exit(1) }

const byCal = {}
for (const a of data) {
  const c = a.calendar_name || '(none)'
  if (!byCal[c]) byCal[c] = { count: 0, sample: a.contact_name, last: a.booked_at }
  byCal[c].count++
  if (a.booked_at > byCal[c].last) { byCal[c].last = a.booked_at; byCal[c].sample = a.contact_name }
}

console.log('=== Calendars with bookings in last 120d, and their classification ===\n')
const rows = Object.entries(byCal).sort((a,b) => b[1].count - a[1].count)
for (const [cal, info] of rows) {
  let cls = 'UNKNOWN ⚠️  NOT COUNTED ANYWHERE'
  if (STRATEGY.has(cal)) cls = 'strategy (counted)'
  else if (INTRO.has(cal)) cls = 'intro (not a qual booking, ok)'
  console.log(`${cal}  n=${String(info.count).padStart(3)}  [${cls}]`)
  console.log(`    latest: ${info.last?.slice(0,10)}  e.g. "${info.sample}"`)
}
