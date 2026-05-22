// match-hook-body-derivation.mjs
//
// Re-runs hook ↔ body ↔ joined matching for the creative library.
// The original one-shot match left huge gaps (only 10/35 hooks matched,
// 21/35 bodies matched, all scores at 1.000 which is suspicious).
//
// Algorithm: word-n-gram overlap, not naive substring containment.
//   - Each joined clip's transcript is normalised + tokenised
//   - For each candidate Hook: score(joined.opening, hook.opening)
//   - For each candidate Body: score(joined.closing, body)
//   - Pick the best hook + best body where score >= MIN_SCORE
//   - Writes derived_hook_id, derived_body_id, derivation_score back to the row
//   - NEVER clobbers a manual override (rows where derivation_score IS NULL
//     are skipped if their derived_* IDs are already set, per the
//     SourceSlot manual-override convention)
//
// Usage: node scripts/match-hook-body-derivation.mjs
//   Set DRY_RUN=1 to preview without writing.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY env var required')
  process.exit(1)
}
const DRY_RUN = process.env.DRY_RUN === '1'

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// Tokenize: lowercase, strip punctuation, split into words >2 chars.
// Drop super-common filler words that don't carry semantic weight.
const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','you','your','youre','were','well','we',
  'is','are','was','were','be','been','being','to','of','in','on','at','for',
  'with','from','that','this','those','these','it','its','as','by','so','not',
  'have','has','had','do','does','did','will','would','could','should','can',
  'may','might','one','two','about','out','over','just','they','their','them',
  'i','my','me','our','us','he','she','him','her','his','hers',
])
function tokens(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
}

// Jaccard similarity over the set of meaningful tokens. Cheap and
// effective for transcripts that paraphrase the same idea.
function jaccard(a, b) {
  if (!a.length || !b.length) return 0
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}

// 3-gram shingle overlap — catches phrase-level matches that Jaccard misses.
function shingles(words, n = 3) {
  const out = new Set()
  for (let i = 0; i <= words.length - n; i++) out.add(words.slice(i, i + n).join(' '))
  return out
}
function shingleOverlap(a, b, n = 3) {
  const sa = shingles(a, n)
  const sb = shingles(b, n)
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const s of sa) if (sb.has(s)) inter++
  return inter / Math.min(sa.size, sb.size)  // catches subset matches
}

// Combined score: token Jaccard + shingle overlap, weighted toward shingles
// because they're more specific.
function score(a, b) {
  return 0.4 * jaccard(a, b) + 0.6 * shingleOverlap(a, b, 3)
}

const MIN_SCORE = 0.30  // tuned to favour precision over recall — better to leave a row
                        // unmatched than to ship a wrong match. Operator's manual
                        // override (SourcePickerModal) cleans up the rest.

// Hook signal lives in the first ~40 words. Joined opens with hook.
// Body signal: bodies are usually 100-300 words; the joined ends with body content.
function hookSignal(text)   { return tokens(text).slice(0, 50) }
function joinedOpen(text)   { return tokens(text).slice(0, 70) }
function bodySignal(text)   { return tokens(text) }
function joinedClose(text)  { const t = tokens(text); return t.slice(Math.max(0, t.length - 200)) }

async function main() {
  console.log('Pulling library rows…')
  const { data: rows, error } = await supabase
    .from('lib_creative_library')
    .select('id, type, status, canonical_name, name, transcript, derived_hook_id, derived_body_id, derivation_score')
    .in('type', ['Hook', 'Body', 'Joined', 'Full Video', 'Retargeting'])
    .eq('exclude_from_library', false)
    .not('transcript', 'is', null)
  if (error) { console.error('Select failed:', error.message); process.exit(1) }

  const hooks   = rows.filter((r) => r.type === 'Hook' && r.transcript?.length > 40)
  const bodies  = rows.filter((r) => r.type === 'Body' && r.transcript?.length > 40)
  const targets = rows.filter((r) => ['Joined', 'Full Video', 'Retargeting'].includes(r.type) && r.transcript?.length > 80)

  console.log(`Pool: ${hooks.length} hooks, ${bodies.length} bodies. Targets: ${targets.length} composites.`)

  // Pre-compute signatures so we don't re-tokenize for each pair
  const hookSigs = hooks.map((h) => ({ row: h, sig: hookSignal(h.transcript) }))
  const bodySigs = bodies.map((b) => ({ row: b, sig: bodySignal(b.transcript) }))

  let updated = 0
  let matchedBoth = 0
  let matchedOnlyHook = 0
  let matchedOnlyBody = 0
  let matchedNeither = 0
  const decisions = []

  let protectedManual = 0
  for (const t of targets) {
    // Respect manual overrides: rows where the operator set derived_*_id
    // via the SourcePickerModal have derivation_score = NULL. Skip those
    // entirely — never clobber a human pick with a heuristic guess.
    const isManual = (t.derived_hook_id || t.derived_body_id) && t.derivation_score == null
    if (isManual) {
      protectedManual++
      decisions.push({
        target: t.canonical_name || t.name,
        hook: '(manual override)',
        body: '(manual override)',
        hookMatched: !!t.derived_hook_id,
        bodyMatched: !!t.derived_body_id,
        protected: true,
      })
      continue
    }

    const tOpen  = joinedOpen(t.transcript)
    const tClose = joinedClose(t.transcript)

    // Best hook
    let bestHook = null
    let bestHookScore = 0
    for (const { row, sig } of hookSigs) {
      const s = score(tOpen, sig)
      if (s > bestHookScore) { bestHookScore = s; bestHook = row }
    }

    // Best body
    let bestBody = null
    let bestBodyScore = 0
    for (const { row, sig } of bodySigs) {
      const s = score(tClose, sig)
      if (s > bestBodyScore) { bestBodyScore = s; bestBody = row }
    }

    const hookId = bestHookScore >= MIN_SCORE ? bestHook.id : null
    const bodyId = bestBodyScore >= MIN_SCORE ? bestBody.id : null
    let conf = null
    if (hookId && bodyId)      conf = (bestHookScore + bestBodyScore) / 2
    else if (hookId)           conf = bestHookScore
    else if (bodyId)           conf = bestBodyScore

    if (hookId && bodyId) matchedBoth++
    else if (hookId)      matchedOnlyHook++
    else if (bodyId)      matchedOnlyBody++
    else                  matchedNeither++

    decisions.push({
      target: t.canonical_name || t.name,
      hook:  bestHook ? `${bestHook.canonical_name || bestHook.name} (${bestHookScore.toFixed(2)})` : `— (best=${bestHookScore.toFixed(2)})`,
      body:  bestBody ? `${bestBody.canonical_name || bestBody.name} (${bestBodyScore.toFixed(2)})` : `— (best=${bestBodyScore.toFixed(2)})`,
      hookMatched: !!hookId,
      bodyMatched: !!bodyId,
      hookScore: bestHookScore,
      bodyScore: bestBodyScore,
    })

    if (!DRY_RUN) {
      const { error: upErr } = await supabase
        .from('lib_creative_library')
        .update({
          derived_hook_id:  hookId,
          derived_body_id:  bodyId,
          derivation_score: conf,
          derivation_matched_at: new Date().toISOString(),
        })
        .eq('id', t.id)
      if (upErr) { console.error('Update failed:', t.id, upErr.message); continue }
      updated++
    }
  }
  console.log(`Manual overrides preserved: ${protectedManual}`)

  console.log('')
  console.log('---')
  console.log(`Both matched:      ${matchedBoth}`)
  console.log(`Only hook matched: ${matchedOnlyHook}`)
  console.log(`Only body matched: ${matchedOnlyBody}`)
  console.log(`Neither matched:   ${matchedNeither}`)
  console.log(`${DRY_RUN ? 'WOULD UPDATE' : 'Updated'}: ${DRY_RUN ? targets.length : updated} rows`)
  console.log('')
  console.log('High-confidence matches (these should be RIGHT — verify a sample):')
  decisions
    .filter((d) => !d.protected && d.hookMatched && d.bodyMatched)
    .sort((a, b) => (b.hookScore + b.bodyScore) - (a.hookScore + a.bodyScore))
    .slice(0, 20)
    .forEach((d) => {
      console.log(`  ${d.target}`)
      console.log(`        hook: ${d.hook}`)
      console.log(`        body: ${d.body}`)
    })
  console.log('')
  console.log('Unmatched (source clip likely not in library — use manual override):')
  decisions
    .filter((d) => !d.protected && !d.hookMatched && !d.bodyMatched)
    .slice(0, 10)
    .forEach((d) => {
      console.log(`  ${d.target}`)
      console.log(`        nearest hook: ${d.hook}`)
      console.log(`        nearest body: ${d.body}`)
    })
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
