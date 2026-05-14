// Verify migration 052 fixed the typeform → closer_calls fuzz match.
// Counts closes in lib_typeform_response_detail for the last 30 days
// before/after expectation: prior view counted 3 false-positive Mikes
// (all $9k/$500 inherited from a single Mike-prefix closer_call) plus
// the real Mike White close. After tightening, the false positives
// should drop because their typeform last_name (Sozzo, Hagan, etc)
// doesn't appear in the originating closer_call's prospect_name.
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

const since = new Date()
since.setDate(since.getDate() - 30)
const sinceStr = since.toISOString().slice(0, 10) + 'T00:00:00Z'

const { data, error } = await sb
  .from('lib_typeform_response_detail')
  .select('response_id, submitted_at, first_name, last_name, email, is_closed, is_live, revenue, cash_collected, cc_outcome, appt_outcome')
  .eq('is_closed', true)
  .gte('submitted_at', sinceStr)
  .order('submitted_at', { ascending: false })

if (error) { console.error('Query failed:', error.message); process.exit(1) }

console.log(`\n=== Typeform is_closed=true in last 30d (after migration 052) ===\n`)
console.log(`Total: ${data.length}\n`)
for (const r of data) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name)'
  console.log(`  ${r.submitted_at.slice(0,10)}  ${name.padEnd(28)}  ${(r.email || '').padEnd(35)}  rev=$${r.revenue}  cash=$${r.cash_collected}  cc=${r.cc_outcome || 'null'}  appt=${r.appt_outcome || 'null'}`)
}

const { data: liveData } = await sb
  .from('lib_typeform_response_detail')
  .select('response_id, first_name, last_name, is_live, cc_outcome, cc_showed, appt_outcome')
  .eq('is_live', true)
  .gte('submitted_at', sinceStr)

console.log(`\n=== Typeform is_live=true in last 30d: ${liveData?.length || 0} ===`)
