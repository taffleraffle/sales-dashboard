// mark-merged-hooks-bodies-as-run.mjs
//
// Per Ben (2026-05-22): any Hook or Body that's been MERGED into a
// composite (Joined / Full Video / Retargeting / Testimony) counts as
// "has_been_run = TRUE", because the act of merging means it shipped
// as part of a live ad.
//
// Two detection passes:
//   1. Derivation link: rows referenced by some composite's
//      derived_hook_id / derived_body_id (populated by the matcher in
//      match-hook-body-derivation.mjs).
//   2. Transcript-overlap heuristic: catches hooks/bodies the matcher
//      couldn't link but whose distinctive 10-word phrases appear
//      verbatim in some composite transcript. This rescues short
//      transcripts and paraphrased variants that fall below the
//      matcher's 0.30 score threshold.
//
// Idempotent — only flips has_been_run from null/false to true; never
// downgrades. Safe to re-run.
//
// Usage:  node scripts/mark-merged-hooks-bodies-as-run.mjs
//         DRY_RUN=1 to preview without writing.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1) }
const DRY_RUN = process.env.DRY_RUN === '1'

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const COMPOSITE_TYPES = ['Joined', 'Full Video', 'Retargeting', 'Testimony']

async function main() {
  console.log('Pulling library rows…')
  const { data: rows, error } = await supabase
    .from('lib_creative_library')
    .select('id, type, status, canonical_name, name, transcript, has_been_run, derived_hook_id, derived_body_id')
    .in('type', ['Hook', 'Body', ...COMPOSITE_TYPES])
    .eq('exclude_from_library', false)
  if (error) { console.error('Select failed:', error.message); process.exit(1) }

  const hooksAndBodies = rows.filter((r) => ['Hook', 'Body'].includes(r.type))
  const composites     = rows.filter((r) => COMPOSITE_TYPES.includes(r.type))

  // --- Pass 1: derivation link ---
  const linkedIds = new Set()
  for (const c of composites) {
    if (c.derived_hook_id) linkedIds.add(c.derived_hook_id)
    if (c.derived_body_id) linkedIds.add(c.derived_body_id)
  }
  const pass1 = hooksAndBodies.filter((r) => linkedIds.has(r.id) && r.has_been_run !== true)
  console.log(`Pass 1 (derivation link): ${pass1.length} hooks/bodies to flag`)

  // --- Pass 2: transcript-overlap ---
  // Build a phrase set from every composite's transcript (10-word sliding
  // window, stepped by 5 words). Then for each unmatched hook/body, check
  // if any of its 10-word windows appears in the composite phrase set.
  const compositePhrases = new Set()
  for (const c of composites) {
    if (!c.transcript || c.transcript.length < 80) continue
    const t = c.transcript.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim()
    const words = t.split(' ').filter((w) => w.length > 1)
    if (words.length < 10) continue
    for (let i = 0; i <= words.length - 10; i++) {
      compositePhrases.add(words.slice(i, i + 10).join(' '))
    }
  }
  console.log(`Composite phrase corpus: ${compositePhrases.size} phrases across ${composites.length} composites`)

  const pass2 = []
  for (const r of hooksAndBodies) {
    if (linkedIds.has(r.id)) continue          // already caught by Pass 1
    if (r.has_been_run === true) continue       // already flagged
    if (!r.transcript || r.transcript.length < 60) continue
    const t = r.transcript.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim()
    const words = t.split(' ').filter((w) => w.length > 1)
    if (words.length < 10) continue
    let hit = false
    for (let i = 0; i <= words.length - 10; i += 5) {
      if (compositePhrases.has(words.slice(i, i + 10).join(' '))) { hit = true; break }
    }
    if (hit) pass2.push(r)
  }
  console.log(`Pass 2 (transcript overlap): ${pass2.length} additional hooks/bodies to flag`)

  // --- Apply ---
  const toFlag = [...pass1, ...pass2]
  const byType = toFlag.reduce((acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc }, {})
  console.log(`\nTotal to flag has_been_run = TRUE:`)
  Object.entries(byType).forEach(([t, n]) => console.log(`  ${t}: ${n}`))

  if (toFlag.length === 0) { console.log('Nothing to update.'); return }

  if (DRY_RUN) {
    console.log('\nDRY_RUN=1 → no writes. Sample of what would change:')
    toFlag.slice(0, 12).forEach((r) => {
      const tag = linkedIds.has(r.id) ? 'LINK' : 'PHRASE'
      console.log(`  [${tag}] ${r.type} ${r.canonical_name || r.name}`)
    })
    return
  }

  // Batch update — Supabase's PostgREST .in() filter handles ~1000 IDs
  // comfortably; we have <100 so a single update is fine.
  const ids = toFlag.map((r) => r.id)
  const { error: upErr, count } = await supabase
    .from('lib_creative_library')
    .update({ has_been_run: true })
    .in('id', ids)
    .select('*', { count: 'exact', head: true })
  if (upErr) { console.error('Update failed:', upErr.message); process.exit(1) }
  console.log(`\nUpdated ${count ?? ids.length} rows.`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
