#!/usr/bin/env node
/**
 * After a Meta sync lands data in public.ads + ad_daily_stats, run the three
 * library functions to populate transcripts → phrase scores → variant states.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')]
    })
)

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })

// PostgREST exposes library.* functions via /rest/v1/rpc/ only if the schema is
// exposed in api.schemas. It usually isn't, so we issue raw SQL via the
// supabase-js v2 .rpc fallback won't work for non-public funcs. Easier: run a
// SELECT that calls the function from the public.lib_* views (which CAN be
// called from anon). We create thin wrappers in public if needed.
//
// For now, paste the calls into Studio or expose functions to anon.
// Quick path: just SELECT through a view we add ad-hoc.

const calls = [
  { label: 'ingest', sql: 'SELECT * FROM library.ingest_ad_copy_to_transcripts()' },
  { label: 'phrases', sql: 'SELECT * FROM library.compute_phrase_performance()' },
  { label: 'states', sql: 'SELECT * FROM library.derive_variant_states()' },
]

console.log('NOTE: PostgREST does not expose library.* functions directly.')
console.log('Run these three SELECTs in Supabase Studio SQL editor:\n')
for (const c of calls) {
  console.log(`-- ${c.label}`)
  console.log(`${c.sql};`)
  console.log()
}

// ── Verification: count what's in each library table afterward ──
console.log('After running them, verify by counting rows...\n')

const { count: tCount } = await supabase.from('lib_creative_transcripts').select('*', { count: 'exact', head: true })
const { count: pCount } = await supabase.from('lib_phrase_performance').select('*', { count: 'exact', head: true })
const { count: sCount } = await supabase.from('lib_variant_state_history').select('*', { count: 'exact', head: true })
const { count: adsCount } = await supabase.from('ads').select('*', { count: 'exact', head: true })
const { count: statsCount } = await supabase.from('ad_daily_stats').select('*', { count: 'exact', head: true })

console.log('Current row counts:')
console.log(`  public.ads:                          ${adsCount ?? '?'}`)
console.log(`  public.ad_daily_stats:               ${statsCount ?? '?'}`)
console.log(`  library.creative_transcripts:        ${tCount ?? '?'}`)
console.log(`  library.phrase_performance:          ${pCount ?? '?'}`)
console.log(`  library.variant_state_history:       ${sCount ?? '?'}`)
