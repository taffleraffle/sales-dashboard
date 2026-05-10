/**
 * Try the multipart/form-data deploy endpoint (the one the Supabase CLI uses).
 * Format per https://supabase.com/docs/reference/api/v1-deploy-a-function
 *
 *   POST /v1/projects/{ref}/functions/deploy?slug=<slug>
 *   Content-Type: multipart/form-data
 *     metadata: JSON  { entrypoint_path, name, verify_jwt, import_map_path? }
 *     file:     the index.ts source (with filename matching entrypoint_path)
 */
import { readFileSync } from 'node:fs'

const SUPABASE_PAT = process.env.SUPABASE_PAT
const RENDER_KEY   = process.env.RENDER_KEY
const PROJECT_REF  = 'kjfaqhmllagbxjdxlopm'
const RENDER_SRV   = 'srv-d6r63qk50q8c73bsrbog'

if (!SUPABASE_PAT) { console.error('Missing SUPABASE_PAT'); process.exit(1) }

// ── Set secrets (already proven working) ────────────────────────
if (RENDER_KEY) {
  const rRes = await fetch(`https://api.render.com/v1/services/${RENDER_SRV}/env-vars`, {
    headers: { 'Authorization': `Bearer ${RENDER_KEY}`, 'Accept': 'application/json' },
  })
  const renderEnv = await rRes.json()
  const renderMap = Object.fromEntries(renderEnv.map(item => {
    const e = item.envVar || item
    return [e.key, e.value]
  }))
  const secrets = [
    { name: 'OPENAI_API_KEY',        value: renderMap.OPENAI_API_KEY },
    { name: 'META_ADS_ACCOUNT_ID',   value: renderMap.VITE_META_ADS_ACCOUNT_ID },
    { name: 'META_ADS_ACCESS_TOKEN', value: renderMap.VITE_META_ADS_ACCESS_TOKEN },
  ].filter(s => s.value)
  const sRes = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/secrets`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUPABASE_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(secrets),
  })
  console.log('[deploy] secrets set:', sRes.status)
}

// ── Multipart deploy ────────────────────────────────────────────
const functions = [
  { slug: 'transcribe-ads', path: '../supabase/functions/transcribe-ads/index.ts' },
  { slug: 'ad-analyst',     path: '../supabase/functions/ad-analyst/index.ts' },
]

for (const fn of functions) {
  const src = readFileSync(new URL(fn.path, import.meta.url), 'utf8')

  const form = new FormData()
  form.append('metadata', JSON.stringify({
    name: fn.slug,
    entrypoint_path: 'index.ts',
    verify_jwt: false,
  }))
  form.append('file', new Blob([src], { type: 'application/typescript' }), 'index.ts')

  console.log(`\n[deploy] ${fn.slug} via multipart deploy endpoint (${src.length} chars)`)

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/deploy?slug=${fn.slug}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SUPABASE_PAT}` },
      body: form,
    }
  )
  const text = await res.text()
  console.log(`  HTTP ${res.status}: ${text.slice(0, 400)}`)
}

// ── Smoke test ──────────────────────────────────────────────────
await new Promise(r => setTimeout(r, 5000))
console.log('\n[smoke] invoking ad-analyst with quick prompt ...')
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
const t = await fetch(`https://${PROJECT_REF}.supabase.co/functions/v1/ad-analyst`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${ANON}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'quick', promptId: 'in_kpi', dateRange: 14 }),
})
console.log('[smoke] HTTP', t.status)
const body = await t.text()
console.log('[smoke] body:', body.slice(0, 600))
