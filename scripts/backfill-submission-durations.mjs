// backfill-submission-durations.mjs
//
// One-off: measure the length of already-approved editor submissions that
// predate the per-minute Invoice tab (migration 139). Probes each stored file
// with ffprobe and writes duration_seconds + duration_source='auto'.
//
// New uploads measure themselves at submit time, so this only ever needs to
// run once (and again only if a big batch is imported without durations).
//
// Run:  SUPABASE_ACCESS_TOKEN=sbp_... node scripts/backfill-submission-durations.mjs
// Needs: ffprobe on PATH.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const REF = 'kjfaqhmllagbxjdxlopm'
const PAT = process.env.SUPABASE_ACCESS_TOKEN
if (!PAT) { console.error('Set SUPABASE_ACCESS_TOKEN'); process.exit(1) }

const CONCURRENCY = 5

async function runSql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text}`)
  return JSON.parse(text)
}

async function probeDuration(url) {
  // -show_entries format=duration reads the container header; for a faststart
  // mp4 this is a few KB, not the whole file.
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nokey=1',
    url,
  ], { timeout: 120000 })
  const n = parseFloat(String(stdout).trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

async function main() {
  const rows = await runSql(`
    select id, file_url from lib_task_submissions
    where approved_at is not null and deleted_at is null
      and file_url is not null and duration_seconds is null
    order by created_at`)
  console.log(`Found ${rows.length} submissions to probe.`)

  const results = []   // { id, dur }
  let i = 0, ok = 0, fail = 0
  async function worker() {
    while (i < rows.length) {
      const idx = i++
      const row = rows[idx]
      try {
        const dur = await probeDuration(row.file_url)
        if (dur != null) { results.push({ id: row.id, dur }); ok++ }
        else { fail++; console.warn(`  [skip] ${row.id} — no duration`) }
      } catch (e) {
        fail++; console.warn(`  [fail] ${row.id} — ${e.message.split('\n')[0]}`)
      }
      if ((ok + fail) % 10 === 0) console.log(`  …${ok + fail}/${rows.length}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  if (results.length === 0) { console.log('Nothing measured.'); return }

  // Single batched UPDATE … FROM (VALUES …).
  const values = results.map(r => `('${r.id}'::uuid, ${r.dur}::numeric)`).join(', ')
  await runSql(`
    update lib_task_submissions as s
       set duration_seconds = v.dur, duration_source = 'auto'
      from (values ${values}) as v(id, dur)
     where s.id = v.id`)

  console.log(`\nDone. Measured ${ok}, wrote ${results.length}, failed/skipped ${fail}.`)
}

main().catch(e => { console.error(e); process.exit(1) })
