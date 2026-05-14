// Full picture: what the Ads dashboard will now show for closes in last 30d.
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

const since = new Date()
since.setDate(since.getDate() - 30)
const sinceStr = since.toISOString().slice(0, 10) + 'T00:00:00Z'

const { data: closeRows } = await sb
  .from('lib_close_resolved')
  .select('closer_call_id, clean_name, prospect_name, revenue, cash_collected, created_at, resolved_ad_id, attribution_source')
  .gte('created_at', sinceStr)
  .order('created_at', { ascending: false })

const { data: tfClosed } = await sb
  .from('lib_typeform_response_detail')
  .select('response_id, submitted_at, first_name, last_name, email, revenue, cash_collected')
  .eq('is_closed', true)
  .gte('submitted_at', sinceStr)

console.log(`\n=== lib_close_resolved (last 30d): ${closeRows?.length || 0} rows ===\n`)
for (const r of closeRows || []) {
  console.log(`  ${r.created_at.slice(0,10)}  ${r.clean_name.padEnd(25)}  rev=$${r.revenue}  cash=$${r.cash_collected}  attr=${r.attribution_source}`)
}

console.log(`\n=== typeform is_closed=true (last 30d): ${tfClosed?.length || 0} rows ===\n`)
for (const r of tfClosed || []) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ')
  console.log(`  ${r.submitted_at.slice(0,10)}  ${name.padEnd(25)}  ${(r.email || '').padEnd(35)}  rev=$${r.revenue}  cash=$${r.cash_collected}`)
}

// Union by nameKey (matches the drilldown / aggregation dedupe logic)
const nameKey = (s) => (s || '').toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, 2).join(' ')
const seen = new Set()
let unionCount = 0, unionRev = 0, unionCash = 0
for (const r of closeRows || []) {
  const k = nameKey(r.clean_name || r.prospect_name)
  if (k && seen.has(k)) continue
  if (k) seen.add(k)
  unionCount++
  unionRev += parseFloat(r.revenue || 0)
  unionCash += parseFloat(r.cash_collected || 0)
}
for (const r of tfClosed || []) {
  const k = nameKey([r.first_name, r.last_name].filter(Boolean).join(' '))
  if (k && seen.has(k)) continue
  if (k) seen.add(k)
  unionCount++
  unionRev += parseFloat(r.revenue || 0)
  unionCash += parseFloat(r.cash_collected || 0)
}
console.log(`\n=== UNION (close + tf), deduped by name: ${unionCount} closes / $${unionRev.toLocaleString()} rev / $${unionCash.toLocaleString()} cash ===\n`)
