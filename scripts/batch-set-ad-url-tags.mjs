#!/usr/bin/env node
/**
 * Batch-set url_tags on every active Meta ad so each click carries the
 * dynamic ID macros into the destination URL.
 *
 * After this runs, Meta will automatically append the following query
 * string to every click on every ad:
 *
 *   utm_source=facebook
 *   utm_medium=paid
 *   utm_campaign={{campaign.id}}
 *   utm_term={{adset.id}}
 *   utm_content={{ad.id}}
 *   utm_name={{campaign.name}}
 *
 * Meta resolves the {{...}} placeholders at click time. Combined with the
 * VSL UTM forwarding snippet (Fix C) on optdigital.io/vsl-*, the resulting
 * Typeform submission carries the exact ad_id in its hidden fields, so
 * sync-typeform resolves typeform_responses.ad_id without any name matching.
 *
 * Usage:
 *   node scripts/batch-set-ad-url-tags.mjs --dry-run      # preview, no writes
 *   node scripts/batch-set-ad-url-tags.mjs --status=ACTIVE  # default
 *   node scripts/batch-set-ad-url-tags.mjs --ad=<single_ad_id>  # one ad
 *
 * Reads Meta token + account from the same .env the browser uses.
 */
import { readFileSync } from 'node:fs'

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const env = Object.fromEntries(
  envText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')] })
)
const ACCOUNT_ID = env.VITE_META_ADS_ACCOUNT_ID
const META_TOKEN = env.VITE_META_ADS_ACCESS_TOKEN
if (!ACCOUNT_ID || !META_TOKEN) {
  console.error('Missing VITE_META_ADS_ACCOUNT_ID or VITE_META_ADS_ACCESS_TOKEN in .env')
  process.exit(1)
}

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const STATUS = (args.find(a => a.startsWith('--status='))?.split('=')[1]) || 'ACTIVE'
const SINGLE = args.find(a => a.startsWith('--ad='))?.split('=')[1]

const BASE = 'https://graph.facebook.com/v21.0'

// The exact url_tags string Meta will append to every click.
const URL_TAGS = [
  'utm_source=facebook',
  'utm_medium=paid',
  'utm_campaign={{campaign.id}}',
  'utm_term={{adset.id}}',
  'utm_content={{ad.id}}',
  'utm_name={{campaign.name}}',
].join('&')

console.log(`[url_tags] target string:\n  ${URL_TAGS}\n`)
console.log(`[url_tags] mode: ${DRY_RUN ? 'DRY-RUN' : 'LIVE WRITES'}`)
console.log(`[url_tags] status filter: ${STATUS}`)
console.log(`[url_tags] account: act_${ACCOUNT_ID}\n`)

// --- Fetch the target ads ---
async function fetchAds() {
  if (SINGLE) {
    const r = await fetch(`${BASE}/${SINGLE}?access_token=${META_TOKEN}&fields=id,name,status,effective_status,url_tags`)
    const j = await r.json()
    if (j.error) { console.error('Single ad fetch failed:', j.error.message); process.exit(2) }
    return [j]
  }
  const out = []
  let url = `${BASE}/act_${ACCOUNT_ID}/ads?` + new URLSearchParams({
    access_token: META_TOKEN,
    effective_status: JSON.stringify([STATUS]),
    fields: 'id,name,status,effective_status,url_tags',
    limit: '200',
  }).toString()
  while (url) {
    const r = await fetch(url)
    const j = await r.json()
    if (j.error) { console.error('List ads failed:', j.error.message); process.exit(2) }
    out.push(...(j.data || []))
    url = j.paging?.next || null
  }
  return out
}

const ads = await fetchAds()
console.log(`[url_tags] found ${ads.length} ${STATUS} ads\n`)

let updated = 0
let alreadySet = 0
let failed = 0
const startedAt = Date.now()

for (let i = 0; i < ads.length; i++) {
  const ad = ads[i]
  const existing = ad.url_tags || ''
  const matches = existing === URL_TAGS
  if (matches) {
    alreadySet++
    continue
  }

  if (DRY_RUN) {
    console.log(`[${i + 1}/${ads.length}] WOULD SET ${ad.id} (${ad.name?.slice(0, 30)})`)
    console.log(`    existing: "${existing}"`)
    updated++
    continue
  }

  // Live write: POST /{ad_id} with url_tags
  try {
    const body = new URLSearchParams({
      access_token: META_TOKEN,
      url_tags: URL_TAGS,
    })
    const r = await fetch(`${BASE}/${ad.id}`, { method: 'POST', body })
    const j = await r.json()
    if (j.error) {
      console.error(`[${i + 1}/${ads.length}] FAILED ${ad.id}: ${j.error.message}`)
      failed++
    } else {
      console.log(`[${i + 1}/${ads.length}] OK     ${ad.id} (${ad.name?.slice(0, 35)})`)
      updated++
    }
  } catch (e) {
    console.error(`[${i + 1}/${ads.length}] EXCEPTION ${ad.id}:`, e.message)
    failed++
  }
}

console.log(`\n[url_tags] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
console.log(`           updated: ${updated}`)
console.log(`           already set: ${alreadySet}`)
console.log(`           failed: ${failed}`)
