// Cross-check live-call universe: union of typeform is_live + GHL lives.
// Mirrors the AdsPerformance live count + drilldown.
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

const since = new Date()
since.setDate(since.getDate() - 30)
const sinceISO = since.toISOString().slice(0, 10) + 'T00:00:00Z'

const { data: tfLive } = await sb.from('lib_typeform_response_detail')
  .select('submitted_at, first_name, last_name, email').eq('is_live', true).gte('submitted_at', sinceISO)
const { data: ghlLive } = await sb.from('lib_ghl_lives_detail')
  .select('landed_at, display_name, ad_id').gte('landed_at', sinceISO)

console.log(`\nTypeform is_live (30d): ${tfLive?.length || 0}`)
for (const r of tfLive || []) console.log(`  ${r.submitted_at.slice(0,10)}  ${[r.first_name,r.last_name].filter(Boolean).join(' ')}  ${r.email||''}`)

console.log(`\nGHL lives (30d): ${ghlLive?.length || 0}`)
for (const r of ghlLive || []) console.log(`  ${r.landed_at.slice(0,10)}  ${r.display_name||'(no name)'}  ad=${r.ad_id||'null'}`)

// Union by name-token (matches dedupeByName in AdsPerformance.jsx)
const nameKey = (s) => (s||'').toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0,2).join(' ')
const seen = new Set()
let n = 0
for (const r of tfLive || []) {
  const k = nameKey([r.first_name,r.last_name].filter(Boolean).join(' '))
  if (k && seen.has(k)) continue
  if (k) seen.add(k)
  n++
}
for (const r of ghlLive || []) {
  const k = nameKey(r.display_name)
  if (k && seen.has(k)) continue
  if (k) seen.add(k)
  n++
}
console.log(`\nUNIONED + DEDUPED lives (30d): ${n}\n`)
console.log('This is what the Ads dashboard "Live calls" tile will show after Render redeploys.')

// Now do 7d for the user's other complaint
const since7 = new Date()
since7.setDate(since7.getDate() - 7)
const since7ISO = since7.toISOString().slice(0, 10) + 'T00:00:00Z'

const { data: tfLive7 } = await sb.from('lib_typeform_response_detail')
  .select('submitted_at, first_name, last_name, email').eq('is_live', true).gte('submitted_at', since7ISO)
const { data: ghlLive7 } = await sb.from('lib_ghl_lives_detail')
  .select('landed_at, display_name, ad_id').gte('landed_at', since7ISO)

const seen7 = new Set()
let n7 = 0
for (const r of tfLive7 || []) {
  const k = nameKey([r.first_name,r.last_name].filter(Boolean).join(' '))
  if (k && seen7.has(k)) continue
  if (k) seen7.add(k)
  n7++
}
for (const r of ghlLive7 || []) {
  const k = nameKey(r.display_name)
  if (k && seen7.has(k)) continue
  if (k) seen7.add(k)
  n7++
}
console.log(`\nUNIONED + DEDUPED lives (7d): ${n7}`)
console.log('Typeform 7d:', tfLive7?.length, '  GHL 7d:', ghlLive7?.length)
