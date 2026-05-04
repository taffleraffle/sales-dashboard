import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)
const STRAT = ['9yoQVPBkNX4tWYmcDkf3','cEyqCFAsPLDkUV8n982h','HDsTrgpsFOXw9V4AkZGq','aQsmGwANALCwJBI7G9vT','StLqrES6WMO8f3Obdu9d','3mLE6t6rCKDdIuIfvP9j','T5Zif5GjDwulya6novU0','gohFzPCilzwBtVfaC6fu']
const since = (() => { const s = new Date(); s.setDate(s.getDate() - 30); return s.toISOString().split('T')[0] })()
const { data } = await supabase.from('ghl_appointments').select('booked_at,appointment_date').in('calendar_name', STRAT).neq('appointment_status','cancelled').gte('appointment_date', since)
const total = (data||[]).length
const withBookedAt = (data||[]).filter(r=>r.booked_at).length
console.log(`Strategy rows in 30d: ${total}  with booked_at: ${withBookedAt}  without: ${total-withBookedAt}`)
