#!/usr/bin/env node
/**
 * One-shot deploy of the ingest-external-submission Edge Function.
 *
 * Single-file function (no _shared imports), so the deploy is simpler
 * than the fanbasis one — just upload index.ts.
 *
 * Usage: SUPABASE_ACCESS_TOKEN=sbp_... node scripts/deploy-ingest-external-submission.mjs
 */
import { readFileSync } from 'node:fs'

const SUPABASE_PAT = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_PAT
const PROJECT_REF = 'kjfaqhmllagbxjdxlopm'

if (!SUPABASE_PAT) {
  console.error('Missing SUPABASE_ACCESS_TOKEN / SUPABASE_PAT')
  process.exit(1)
}

const indexTs = readFileSync(
  new URL('../supabase/functions/ingest-external-submission/index.ts', import.meta.url),
  'utf8',
)

const form = new FormData()
form.append('metadata', JSON.stringify({
  name: 'ingest-external-submission',
  entrypoint_path: 'index.ts',
  // Set false so the DB trigger (pg_net, no auth header) and the
  // dashboard Retry RPC can both invoke without a Bearer token.
  // The function itself only reads/writes via service-role from env,
  // and trusts only submission_id (which is a UUID, not a user-
  // provided permission).
  verify_jwt: false,
}))
form.append('file', new Blob([indexTs], { type: 'application/typescript' }), 'index.ts')

console.log(`[deploy] uploading ingest-external-submission (${indexTs.length} chars)`)

const res = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/deploy?slug=ingest-external-submission`,
  { method: 'POST', headers: { Authorization: `Bearer ${SUPABASE_PAT}` }, body: form },
)
const text = await res.text()
console.log(`HTTP ${res.status}: ${text.slice(0, 800)}`)
process.exit(res.ok ? 0 : 2)
