/**
 * Deploys hyros-webhook (patched) + hyros-sync (new) via Supabase Management
 * multipart endpoint, and sets HYROS_API_KEY in Supabase function secrets from
 * Render env vars.
 *
 * Usage:
 *   SUPABASE_PAT=sbp_... RENDER_KEY=rnd_... node scripts/deploy-hyros.mjs
 */
import { readFileSync } from 'node:fs'

const SUPABASE_PAT = process.env.SUPABASE_PAT
const RENDER_KEY   = process.env.RENDER_KEY
const PROJECT_REF  = 'kjfaqhmllagbxjdxlopm'
const RENDER_SRV   = 'srv-d6r63qk50q8c73bsrbog'

if (!SUPABASE_PAT) { console.error('Missing SUPABASE_PAT'); process.exit(1) }

// ── Set HYROS_API_KEY secret from Render ──────────────────────────────
if (RENDER_KEY) {
  const rRes = await fetch(`https://api.render.com/v1/services/${RENDER_SRV}/env-vars`, {
    headers: { Authorization: `Bearer ${RENDER_KEY}`, Accept: 'application/json' },
  })
  const renderEnv = await rRes.json()
  const renderMap = Object.fromEntries(renderEnv.map(item => {
    const e = item.envVar || item
    return [e.key, e.value]
  }))
  const secrets = [
    { name: 'HYROS_API_KEY', value: renderMap.VITE_HYROS_API_KEY },
  ].filter(s => s.value)
  if (secrets.length) {
    const sRes = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/secrets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(secrets),
    })
    console.log('[deploy] HYROS_API_KEY secret set:', sRes.status)
  } else {
    console.log('[deploy] no HYROS_API_KEY in Render env, skipping secret set')
  }
}

// ── Multipart deploy ──────────────────────────────────────────────────
const functions = [
  { slug: 'hyros-webhook', path: '../supabase/functions/hyros-webhook/index.ts' },
  { slug: 'hyros-sync',    path: '../supabase/functions/hyros-sync/index.ts'    },
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

  console.log(`\n[deploy] ${fn.slug} (${src.length} chars)`)

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/deploy?slug=${fn.slug}`,
    { method: 'POST', headers: { Authorization: `Bearer ${SUPABASE_PAT}` }, body: form }
  )
  console.log(`  HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

// ── Smoke-test hyros-sync ─────────────────────────────────────────────
await new Promise(r => setTimeout(r, 4000))
console.log('\n[smoke] invoking hyros-sync with days=7 ...')
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
const t = await fetch(`https://${PROJECT_REF}.supabase.co/functions/v1/hyros-sync`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ days: 7 }),
})
console.log('[smoke] HTTP', t.status)
console.log('[smoke] body:', (await t.text()).slice(0, 800))
