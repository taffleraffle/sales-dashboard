// Show every strategy booking scheduled on each of the last 7 days, with
// closer assignment. So Ben/Daniel can mark up who showed vs no-show'd.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

const STRAT = ['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0','gohFzPCilzwBtVfaC6fu']

for (const day of ['2026-04-28', '2026-04-29', '2026-04-30', '2026-05-01', '2026-05-04']) {
  const { data: rows } = await supabase
    .from('ghl_appointments')
    .select('start_time, contact_name, calendar_name, appointment_status, revenue_tier')
    .eq('appointment_date', day)
    .in('calendar_name', STRAT)
    .order('start_time')
  console.log(`\n=== ${day} (${(rows || []).length} scheduled, ${(rows || []).filter(r => r.appointment_status !== 'cancelled').length} active) ===`)
  for (const r of rows || []) {
    const status = r.appointment_status === 'cancelled' ? '[CANCELLED] ' : ''
    const tier = r.revenue_tier ? `[${r.revenue_tier.replace(/[$,]/g, '').slice(0, 12)}]` : ''
    const time = r.start_time?.split(' ')[1]?.slice(0, 5) || '--:--'
    console.log(`  ${time}  ${status}${(r.contact_name || '').padEnd(60)} ${tier}`)
  }
}
