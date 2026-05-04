import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

const STRAT = ['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0','gohFzPCilzwBtVfaC6fu']

const { data } = await supabase
  .from('ghl_appointments')
  .select('contact_name, calendar_name, appointment_status, created_at, updated_at, ghl_event_id')
  .eq('appointment_date', '2026-05-04')
  .in('calendar_name', STRAT)
  .order('created_at')
console.log(`May 4 strategy rows: ${data?.length || 0}`)
for (const r of data || []) {
  console.log(`  ${r.created_at?.slice(0, 19)}  cal=${r.calendar_name.slice(0, 6)}  status=${r.appointment_status}  "${r.contact_name}"`)
}

// Marketing tracker timestamp
const { data: mt } = await supabase.from('marketing_tracker').select('date, qualified_bookings, updated_at').eq('date', '2026-05-04').single()
console.log(`\nmarketing_tracker May 4: Q.BOOK=${mt?.qualified_bookings}, updated_at=${mt?.updated_at}`)
