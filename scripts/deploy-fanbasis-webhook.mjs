#!/usr/bin/env node
/**
 * One-shot deploy of the fanbasis-webhook Edge Function.
 *
 * The function imports `../_shared/matchPayment.ts`, so we send both files
 * in a single multipart deploy. Supabase's deploy API accepts repeated `file`
 * fields whose form-filename becomes the path inside the function bundle.
 *
 * Usage: SUPABASE_ACCESS_TOKEN=sbp_... node scripts/deploy-fanbasis-webhook.mjs
 */
import { readFileSync } from 'node:fs'

const SUPABASE_PAT = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_PAT
const PROJECT_REF = 'kjfaqhmllagbxjdxlopm'

if (!SUPABASE_PAT) {
  console.error('Missing SUPABASE_ACCESS_TOKEN / SUPABASE_PAT')
  process.exit(1)
}

const indexTs = readFileSync(new URL('../supabase/functions/fanbasis-webhook/index.ts', import.meta.url), 'utf8')
const sharedTs = readFileSync(new URL('../supabase/functions/_shared/matchPayment.ts', import.meta.url), 'utf8')

const form = new FormData()
form.append('metadata', JSON.stringify({
  name: 'fanbasis-webhook',
  entrypoint_path: 'index.ts',
  verify_jwt: false,
}))
form.append('file', new Blob([indexTs], { type: 'application/typescript' }), 'index.ts')
form.append('file', new Blob([sharedTs], { type: 'application/typescript' }), '../_shared/matchPayment.ts')

console.log(`[deploy] uploading fanbasis-webhook (${indexTs.length} + ${sharedTs.length} chars)`)

const res = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/deploy?slug=fanbasis-webhook`,
  { method: 'POST', headers: { 'Authorization': `Bearer ${SUPABASE_PAT}` }, body: form }
)
const text = await res.text()
console.log(`HTTP ${res.status}: ${text.slice(0, 800)}`)
process.exit(res.ok ? 0 : 2)
