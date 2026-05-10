#!/usr/bin/env node
/**
 * One-shot Supabase Edge Function deploy via Management API.
 *
 * - Reads OPENAI / META secrets from Render (already configured there)
 * - Sets them as Supabase Edge Function secrets (NOT as Render env vars, where
 *   they sit unused on a static-site deployment)
 * - Inlines the _shared/cors.ts helper into each function body
 * - Creates or updates both transcribe-ads and ad-analyst functions
 *
 * Usage: SUPABASE_PAT=sbp_... RENDER_KEY=rnd_... node scripts/deploy-edge-functions.mjs
 *
 * No persistent storage of keys — script pulls from Render API at runtime
 * each time. To re-deploy, just re-run.
 */
import { readFileSync } from 'node:fs'

const SUPABASE_PAT  = process.env.SUPABASE_PAT
const RENDER_KEY    = process.env.RENDER_KEY
const PROJECT_REF   = 'kjfaqhmllagbxjdxlopm'
const RENDER_SRV    = 'srv-d6r63qk50q8c73bsrbog'   // sales-dashboard static site

if (!SUPABASE_PAT) { console.error('Missing SUPABASE_PAT'); process.exit(1) }
if (!RENDER_KEY)   { console.error('Missing RENDER_KEY');   process.exit(1) }

// ── 1. Pull secrets from Render ──────────────────────────────────
console.log('[deploy] reading secret values from Render...')
const rRes = await fetch(`https://api.render.com/v1/services/${RENDER_SRV}/env-vars`, {
  headers: { 'Authorization': `Bearer ${RENDER_KEY}`, 'Accept': 'application/json' },
})
if (!rRes.ok) { console.error('Render API error:', rRes.status, await rRes.text()); process.exit(2) }
const renderEnv = await rRes.json()
const renderMap = Object.fromEntries(renderEnv.map(item => {
  const e = item.envVar || item
  return [e.key, e.value]
}))

const secrets = [
  { name: 'OPENAI_API_KEY',        value: renderMap.OPENAI_API_KEY },
  { name: 'META_ADS_ACCOUNT_ID',   value: renderMap.VITE_META_ADS_ACCOUNT_ID },
  { name: 'META_ADS_ACCESS_TOKEN', value: renderMap.VITE_META_ADS_ACCESS_TOKEN },
]
for (const s of secrets) {
  if (!s.value) { console.error(`Missing Render env var for ${s.name}`); process.exit(3) }
  console.log(`  ${s.name}: ${s.value.slice(0,6)}...${s.value.slice(-4)} (len=${s.value.length})`)
}

// ── 2. Set secrets in Supabase Edge Functions ────────────────────
console.log('\n[deploy] setting Supabase Edge Function secrets...')
const sRes = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/secrets`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${SUPABASE_PAT}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(secrets),
})
if (!sRes.ok) { console.error('Supabase secrets error:', sRes.status, await sRes.text()); process.exit(4) }
console.log(`[deploy] secrets set (${sRes.status})`)

// ── 3. Deploy each function (CORS is already inlined in source) ──
const functions = [
  { slug: 'transcribe-ads', path: '../supabase/functions/transcribe-ads/index.ts' },
  { slug: 'ad-analyst',     path: '../supabase/functions/ad-analyst/index.ts' },
]

for (const fn of functions) {
  const body = readFileSync(new URL(fn.path, import.meta.url), 'utf8')

  console.log(`\n[deploy] uploading function: ${fn.slug} (${body.length} chars)`)

  // Supabase Management API v1: POST/PATCH /functions with JSON body
  // containing `slug`, `name`, `body` (TS source as string), and `verify_jwt`.
  const payload = {
    slug: fn.slug,
    name: fn.slug,
    body,
    verify_jwt: false,  // we want anon dashboard users to be able to invoke
  }

  let res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/functions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_PAT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  // 400 "Duplicated function slug" or 409 — either way, update via PATCH
  if (res.status === 409 || res.status === 400) {
    const peek = await res.clone().text()
    if (peek.toLowerCase().includes('duplicat') || res.status === 409) {
      console.log(`[deploy]   already exists — updating via PATCH`)
      res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/${fn.slug}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${SUPABASE_PAT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body, verify_jwt: false }),
      })
    }
  }

  if (!res.ok) {
    console.error(`[deploy] ${fn.slug} deploy failed: ${res.status}`)
    console.error(await res.text())
    process.exit(5)
  }
  const json = await res.json().catch(() => ({}))
  console.log(`[deploy] ${fn.slug} OK (${res.status}, id=${json.id || '?'}, version=${json.version || '?'})`)
}

console.log('\n[deploy] DONE — both Edge Functions deployed + secrets set.')
console.log('Test endpoints:')
console.log(`  https://${PROJECT_REF}.supabase.co/functions/v1/transcribe-ads`)
console.log(`  https://${PROJECT_REF}.supabase.co/functions/v1/ad-analyst`)
