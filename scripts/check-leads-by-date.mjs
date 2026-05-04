import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY)

// Marketing tracker leads per day in trailing 30
const since = (() => { const s = new Date(); s.setDate(s.getDate() - 30); return s.toISOString().split('T')[0] })()
const { data } = await supabase
  .from('marketing_tracker')
  .select('date, leads, qualified_bookings, auto_bookings, updated_at')
  .gte('date', since)
  .order('date')
let totLeads = 0, totQ = 0, totA = 0
console.log('Date         Leads  Q.BOOK  AUTO  updated_at')
for (const r of data || []) {
  console.log(`  ${r.date}  ${String(r.leads || 0).padStart(5)}  ${String(r.qualified_bookings || 0).padStart(6)}  ${String(r.auto_bookings || 0).padStart(4)}  ${r.updated_at?.slice(0, 19)}`)
  totLeads += r.leads || 0
  totQ += r.qualified_bookings || 0
  totA += r.auto_bookings || 0
}
console.log(`\n30d total:  leads=${totLeads}  Q.BOOK=${totQ}  AUTO=${totA}`)

// Trailing 7d
const since7 = (() => { const s = new Date(); s.setDate(s.getDate() - 7); return s.toISOString().split('T')[0] })()
const tail7 = (data || []).filter(r => r.date >= since7)
const tail7Leads = tail7.reduce((s, r) => s + (r.leads || 0), 0)
const tail7Q = tail7.reduce((s, r) => s + (r.qualified_bookings || 0), 0)
console.log(`7d  total:  leads=${tail7Leads}  Q.BOOK=${tail7Q}`)
