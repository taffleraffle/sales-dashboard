// backfill-display-names.mjs
//
// One-shot migration of every pre-overhaul lib_creative_library row into
// the new bulletproof display_name format:
//
//   {TYPE}-{OFFER}-{MESSAGING}-{ACTOR}-T{NN}.{ext}
//   e.g. BODY-ACCOUNTANT-STOP-PAYING-FOR-LEADS-OSO-T01.mp4
//
// Strategy: invoke the creative-library-describe Edge Function in BATCHES,
// print a review table after each batch, and pause for the operator to
// approve before continuing. The Edge Function itself does the real work
// (Claude call + display_name construction + DB write) — this script is
// purely the orchestrator + review gate.
//
// Why batch-then-pause: Ben's request was "show me a review table BEFORE
// writing display_name." A full dry-run would require a separate Edge
// Function mode. Batching (5 at a time) gives near-equivalent control:
// after every 5 rows Ben can see the actual new names, validate them,
// and either continue or quit. Already-written rows stay correct; only
// the un-processed tail is skipped on quit.
//
// Requires:
//   SUPABASE_SERVICE_ROLE_KEY   write access to lib_creative_library
//   SUPABASE_USER_ACCESS_TOKEN  for invoking the Edge Function as a user
//                               (or set DESCRIBE_URL + service_key auth)
//
// Usage:
//   node scripts/backfill-display-names.mjs
//   node scripts/backfill-display-names.mjs --batch-size 10
//   node scripts/backfill-display-names.mjs --limit 50
//   node scripts/backfill-display-names.mjs --auto       (no pause)
//   node scripts/backfill-display-names.mjs --where bad-take  (only is_bad_take=false rows)

import { createClient } from '@supabase/supabase-js'
import readline from 'node:readline'

const SUPABASE_URL = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY required (Render env var or local .env)')
  process.exit(1)
}

// Parse CLI args
const args = process.argv.slice(2)
const argVal = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : null
}
const BATCH_SIZE = Number(argVal('--batch-size') || 5)
const LIMIT      = Number(argVal('--limit') || 0)  // 0 = no limit
// `let` not `const` so the `s` keypress inside the batch loop can flip it
// at runtime without rebuilding the script. Previous version wrote to
// process.env.__AUTO and read the captured const — silent no-op.
let   AUTO       = args.includes('--auto')
const WHERE_TAG  = argVal('--where') || null
const DESCRIBE_URL = `${SUPABASE_URL}/functions/v1/creative-library-describe`

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// Pause for the operator. Returns the keypress: 'enter' / 'q' / 's'.
function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (ans) => { rl.close(); resolve((ans || '').trim().toLowerCase()) })
  })
}

// Truncate-and-pad helper for the review table.
const col = (s, w) => {
  const str = String(s ?? '')
  if (str.length <= w) return str.padEnd(w)
  return str.slice(0, w - 1) + '…'
}

async function fetchRowsToBackfill() {
  // Backfill candidates: anything without a display_name yet. Include rows
  // that DO have a transcript OR a visual_description (otherwise describe
  // would skip them anyway). Prefer most-recent so the active editing
  // queue is correct first; old archived rows can wait.
  let q = supabase.from('lib_creative_library')
    .select('id, name, canonical_name, display_name, type, status, creator, offer_slug, transcript, visual_description, added_at, is_bad_take')
    .is('display_name', null)
    .eq('exclude_from_library', false)
    .or('transcript.not.is.null,visual_description.not.is.null')
    .order('added_at', { ascending: false })

  if (WHERE_TAG === 'bad-take')  q = q.eq('is_bad_take', false)
  if (LIMIT > 0) q = q.limit(LIMIT)

  const { data, error } = await q
  if (error) throw new Error(`fetch: ${error.message}`)
  return data || []
}

async function invokeDescribe(libraryIds) {
  const res = await fetch(DESCRIBE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Service role key in Authorization works for Edge Functions.
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'apikey': SERVICE_KEY,
    },
    body: JSON.stringify({ library_ids: libraryIds }),
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`describe HTTP ${res.status}: ${txt.slice(0, 300)}`)
  }
  return await res.json()
}

async function main() {
  const rows = await fetchRowsToBackfill()
  console.log(`\nFound ${rows.length} rows needing display_name backfill.`)
  if (!rows.length) {
    console.log('Nothing to do.')
    return
  }

  console.log(`Batch size: ${BATCH_SIZE}`)
  console.log(`Auto mode: ${AUTO ? 'YES (no pauses)' : 'NO (pause after each batch)'}`)
  if (WHERE_TAG) console.log(`Filter: ${WHERE_TAG}`)
  console.log('')

  // Preview the first 5 row legacy names so Ben can sanity-check the
  // candidate set before any Claude calls happen.
  console.log('First 5 candidates:')
  rows.slice(0, 5).forEach((r, i) => {
    console.log(`  ${i + 1}. ${col(r.canonical_name || r.name, 60)}  [${r.type || '?'} / ${r.status || '?'}]`)
  })
  console.log('')

  if (!AUTO) {
    const ans = await prompt('Start backfill? [y/N/q]: ')
    if (ans !== 'y' && ans !== 'yes') {
      console.log('Aborted.')
      return
    }
  }

  let totalProcessed = 0
  let totalUpdated = 0
  let totalErrored = 0
  const allErrors = []

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const batchNo = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(rows.length / BATCH_SIZE)

    console.log(`\n--- Batch ${batchNo}/${totalBatches} (rows ${i + 1}-${i + batch.length}) ---`)
    process.stdout.write('Calling describe Edge Function… ')
    let result
    try {
      result = await invokeDescribe(batch.map(r => r.id))
      console.log('done.')
    } catch (e) {
      console.log(`FAILED: ${e.message}`)
      const ans = AUTO ? 'y' : await prompt('Continue with next batch? [y/N]: ')
      if (ans !== 'y' && ans !== 'yes') break
      continue
    }

    // Index results by id for the review table
    const byId = new Map((result.rows || []).map(r => [r.id, r]))

    console.log('')
    console.log(`  ${col('OLD canonical_name', 38)} → ${col('NEW display_name', 50)} ${'NOTES'}`)
    console.log(`  ${'-'.repeat(38)}   ${'-'.repeat(50)} ${'-'.repeat(10)}`)
    for (const row of batch) {
      const out = byId.get(row.id)
      if (!out) {
        console.log(`  ${col(row.canonical_name || row.name, 38)} → ${col('(no result)', 50)} —`)
        continue
      }
      if (out.skipped) {
        console.log(`  ${col(row.canonical_name || row.name, 38)} → ${col('(skipped)', 50)} ${out.skipped}`)
        continue
      }
      console.log(`  ${col(row.canonical_name || row.name, 38)} → ${col(out.new_display_name, 50)} T${out.take_number || '?'}`)
    }
    if (result.errors?.length) {
      console.log('')
      console.log(`  ERRORS in this batch (${result.errors.length}):`)
      for (const e of result.errors) {
        console.log(`    ${e.id}: ${e.error}`)
        allErrors.push(e)
      }
    }

    totalProcessed += batch.length
    totalUpdated   += (result.updated || 0)
    totalErrored   += (result.errors?.length || 0)

    if (!AUTO && i + BATCH_SIZE < rows.length) {
      const ans = await prompt('\n[enter] continue · [q] quit · [s] skip pauses for the rest: ')
      if (ans === 'q' || ans === 'quit') {
        console.log('Stopped by operator.')
        break
      }
      if (ans === 's' || ans === 'skip') {
        console.log('Skipping pauses for the rest…')
        AUTO = true   // mutate the let so subsequent iterations skip the prompt
      }
    }
  }

  console.log('\n=== Backfill summary ===')
  console.log(`Rows considered:  ${rows.length}`)
  console.log(`Rows processed:   ${totalProcessed}`)
  console.log(`Rows updated:     ${totalUpdated}`)
  console.log(`Rows errored:     ${totalErrored}`)
  if (allErrors.length) {
    console.log('\nFirst 10 errors:')
    allErrors.slice(0, 10).forEach(e => console.log(`  ${e.id}: ${e.error}`))
  }
  console.log('\nRe-run the script to backfill any remaining rows (it only')
  console.log('picks up rows where display_name is still NULL).')
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
