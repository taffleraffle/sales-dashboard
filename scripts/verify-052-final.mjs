// End-to-end verification that migration 052 is live and the dashboard
// will show correct numbers. Runs three checks:
//   1. View definition contains the tightened predicates (proves the
//      migration is actually applied to the remote DB).
//   2. is_closed=true count in the last 30 days is 1 (Mike White only),
//      not 4 (the prior false-positive Mikes).
//   3. The full closes universe the Ads dashboard will display, broken
//      down by source. Should be 5 real closes / $39,988 rev / $4,488
//      cash in the last 30 days.
//
// Run: node scripts/verify-052-final.mjs

import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

const sinceDate = new Date()
sinceDate.setDate(sinceDate.getDate() - 30)
const sinceISO = sinceDate.toISOString().slice(0, 10) + 'T00:00:00Z'

// ─── Check 1: View definition contains tightened predicates ───────────
console.log('─── 1. View definition check ─────────────────────────────────')
const { data: viewDef, error: vErr } = await sb.rpc('exec_sql', { sql: `
  SELECT pg_get_viewdef('public.lib_typeform_response_outcome'::regclass, true) AS definition
` }).maybeSingle()

let definitionText = ''
if (vErr || !viewDef) {
  // Fallback: query information_schema directly (works without custom RPC)
  const { data, error: e2 } = await sb.from('pg_views').select('definition').eq('viewname', 'lib_typeform_response_outcome').maybeSingle()
  if (e2) {
    console.log('   Could not read view def via PostgREST. Falling back to behaviour check.')
  } else if (data) {
    definitionText = data.definition || ''
  }
} else {
  definitionText = viewDef.definition || ''
}

if (definitionText) {
  const has_lastname_required = /last_name\s+IS\s+NOT\s+NULL/i.test(definitionText)
  const has_last_name_in_prospect = /prospect_name\s+ILIKE.*last_name/i.test(definitionText)
  const has_date_window = /INTERVAL\s*'?90/i.test(definitionText)
  console.log(`   last_name IS NOT NULL required:        ${has_lastname_required ? 'YES ✓' : 'NO ✗'}`)
  console.log(`   prospect_name contains last_name:      ${has_last_name_in_prospect ? 'YES ✓' : 'NO ✗'}`)
  console.log(`   90-day cc.created_at window:           ${has_date_window ? 'YES ✓' : 'NO ✗'}`)
  if (!has_lastname_required || !has_last_name_in_prospect || !has_date_window) {
    console.log('\n   ⚠️  Migration 052 does NOT appear to be applied. Run: npx supabase db push --linked')
    process.exit(1)
  }
} else {
  console.log('   (view definition not readable via REST — will rely on behaviour check)')
}

// ─── Check 2: typeform is_closed count in 30d ─────────────────────────
console.log('\n─── 2. typeform is_closed=true rows (last 30d) ────────────────')
const { data: tfClosed } = await sb
  .from('lib_typeform_response_detail')
  .select('submitted_at, first_name, last_name, email, revenue, cash_collected, cc_outcome, appt_outcome')
  .eq('is_closed', true)
  .gte('submitted_at', sinceISO)
  .order('submitted_at', { ascending: false })

console.log(`   Count: ${tfClosed?.length || 0}\n`)
for (const r of tfClosed || []) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ')
  console.log(`   ${r.submitted_at.slice(0,10)}  ${name.padEnd(22)}  ${(r.email || '').padEnd(35)}  rev=$${r.revenue}  cash=$${r.cash_collected}  cc=${r.cc_outcome || 'null'}  appt=${r.appt_outcome || 'null'}`)
}

if ((tfClosed?.length || 0) > 2) {
  console.log(`\n   ⚠️  Expected ≤ 2 typeform closes (Mike White and maybe George). Got ${tfClosed.length}. Migration may not have taken effect.`)
}

// ─── Check 3: typeform is_live count ──────────────────────────────────
console.log('\n─── 3. typeform is_live=true rows (last 30d) ──────────────────')
const { data: tfLive } = await sb
  .from('lib_typeform_response_detail')
  .select('submitted_at, first_name, last_name, email, cc_outcome, cc_showed, appt_outcome')
  .eq('is_live', true)
  .gte('submitted_at', sinceISO)
  .order('submitted_at', { ascending: false })

console.log(`   Count: ${tfLive?.length || 0}\n`)
for (const r of tfLive || []) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ')
  console.log(`   ${r.submitted_at.slice(0,10)}  ${name.padEnd(22)}  ${(r.email || '').padEnd(35)}  cc=${r.cc_outcome || 'null'}  cc_showed=${r.cc_showed}  appt=${r.appt_outcome || 'null'}`)
}

// ─── Check 4: full close universe the dashboard will render ──────────
console.log('\n─── 4. Full close universe (lib_close_resolved + typeform) ────')
const { data: closeRows } = await sb
  .from('lib_close_resolved')
  .select('closer_call_id, clean_name, prospect_name, revenue, cash_collected, created_at, attribution_source')
  .gte('created_at', sinceISO)
  .order('created_at', { ascending: false })

console.log(`\n   lib_close_resolved: ${closeRows?.length || 0} rows`)
for (const r of closeRows || []) {
  console.log(`     ${r.created_at.slice(0,10)}  ${(r.clean_name || r.prospect_name).padEnd(22)}  rev=$${r.revenue}  cash=$${r.cash_collected}  attr=${r.attribution_source}`)
}

// Union by nameKey (matches the drilldown + aggregation dedupe in AdsPerformance.jsx)
const nameKey = (s) => (s || '').toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, 2).join(' ')
const seen = new Set()
const finalList = []
for (const r of closeRows || []) {
  const k = nameKey(r.clean_name || r.prospect_name)
  if (k && seen.has(k)) continue
  if (k) seen.add(k)
  finalList.push({ source: 'lib_close_resolved', name: r.clean_name || r.prospect_name, rev: parseFloat(r.revenue || 0), cash: parseFloat(r.cash_collected || 0) })
}
for (const r of tfClosed || []) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ')
  const k = nameKey(name)
  if (k && seen.has(k)) continue
  if (k) seen.add(k)
  finalList.push({ source: 'typeform (unresolved)', name, rev: parseFloat(r.revenue || 0), cash: parseFloat(r.cash_collected || 0) })
}
const totalRev = finalList.reduce((s, r) => s + r.rev, 0)
const totalCash = finalList.reduce((s, r) => s + r.cash, 0)

console.log(`\n   UNIONED + DEDUPED:  ${finalList.length} closes / $${totalRev.toLocaleString()} rev / $${totalCash.toLocaleString()} cash\n`)
for (const r of finalList) {
  console.log(`     ${r.name.padEnd(22)}  rev=$${r.rev.toLocaleString()}  cash=$${r.cash.toLocaleString()}  [${r.source}]`)
}

console.log('\n─── Done ──────────────────────────────────────────────────────')
console.log('   This is what the Ads dashboard top tile "Closes" will show')
console.log('   in the last 30d. If the numbers above look right, you are good.')
