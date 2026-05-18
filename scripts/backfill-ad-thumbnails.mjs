// One-time backfill for ad thumbnails.
//
// Targets two cohorts:
//   1. Ads with NULL creative_id (587 rows) — fetch creative from Meta + mirror thumbnail
//   2. Ads whose stored asset_url is still a Meta CDN URL (the originals that
//      will eventually 403 once the signed token expires) — re-fetch creative
//      + mirror thumbnail.
//
// Prerequisites:
//   - .env must contain VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//     VITE_META_ADS_ACCESS_TOKEN
//   - migration 066 (ad-thumbnails bucket) must be applied
//
// Usage:
//   node scripts/backfill-ad-thumbnails.mjs           # dry run, just shows counts
//   node scripts/backfill-ad-thumbnails.mjs --run     # actually backfill
//   node scripts/backfill-ad-thumbnails.mjs --run --limit 50

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const env = readFileSync('.env', 'utf-8').split('\n').reduce((m, line) => {
  const [k, ...v] = line.split('=')
  if (k && v.length) m[k.trim()] = v.join('=').trim()
  return m
}, {})

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
const ACCESS_TOKEN = env.VITE_META_ADS_ACCESS_TOKEN
const BASE_URL = 'https://graph.facebook.com/v21.0'

const args = process.argv.slice(2)
const RUN = args.includes('--run')
const LIMIT = (() => {
  const i = args.indexOf('--limit'); if (i === -1) return Infinity
  const n = parseInt(args[i + 1], 10); return Number.isFinite(n) ? n : Infinity
})()

if (!ACCESS_TOKEN) {
  console.error('VITE_META_ADS_ACCESS_TOKEN missing from .env'); process.exit(1)
}

// ─── helpers ports of metaAdsSync.js ─────────────────────────────────────
const FIELDS = ['name','status','effective_status','creative_id',
  'creative{id,image_url,video_id,thumbnail_url,body,title,object_type,call_to_action_type,object_story_spec}',
].join(',')

function detectAssetType(c) {
  if (!c) return 'unknown'
  if (c.video_id || c.object_type === 'VIDEO') return 'video'
  const oss = c.object_story_spec
  if (oss?.video_data?.video_id) return 'video'
  if (c.image_url || c.image_hash) return 'image'
  if (oss?.photo_data?.image_url || oss?.photo_data?.url) return 'image'
  if (oss?.link_data?.picture || oss?.link_data?.image_url) return 'image'
  if (c.object_type === 'SHARE' && oss?.link_data?.child_attachments) return 'carousel'
  return 'unknown'
}
function extractImageUrl(c) {
  if (!c) return null
  const oss = c.object_story_spec
  return (
    c.image_url ||
    oss?.video_data?.image_url ||
    oss?.photo_data?.image_url || oss?.photo_data?.url ||
    oss?.link_data?.picture || oss?.link_data?.image_url ||
    oss?.link_data?.child_attachments?.[0]?.picture ||
    oss?.link_data?.child_attachments?.[0]?.image_url ||
    c.thumbnail_url ||
    null
  )
}
function extractMeta(c) {
  if (!c) return {}
  const link = c.object_story_spec?.link_data
  const vid = c.object_story_spec?.video_data
  return {
    headline: c.title || link?.name || vid?.title || null,
    primary_text: c.body || link?.message || vid?.message || null,
    description: link?.description || null,
    cta_type: c.call_to_action_type || link?.call_to_action?.type || vid?.call_to_action?.type || null,
    destination_url: link?.link || vid?.call_to_action?.value?.link || null,
  }
}

async function persistThumb(adId, metaUrl) {
  if (!adId || !metaUrl) return null
  try {
    const res = await fetch(metaUrl)
    if (!res.ok) { console.warn(`  thumb fetch ${res.status} for ${adId}`); return null }
    const ct = res.headers.get('content-type') || 'image/jpeg'
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg'
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) return null
    const path = `${adId}.${ext}`
    const { error } = await supabase.storage
      .from('ad-thumbnails')
      .upload(path, bytes, { contentType: ct, upsert: true, cacheControl: '604800' })
    if (error) { console.warn(`  upload failed for ${adId}: ${error.message}`); return null }
    const { data } = supabase.storage.from('ad-thumbnails').getPublicUrl(path)
    return data?.publicUrl || null
  } catch (e) { console.warn(`  thumb exception for ${adId}: ${e.message}`); return null }
}

async function fetchOne(adId) {
  const url = `${BASE_URL}/${adId}?fields=${FIELDS}&access_token=${ACCESS_TOKEN}`
  const res = await fetch(url)
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    return { error: j.error?.message || `HTTP ${res.status}` }
  }
  const json = await res.json()
  const c = json.creative
  const bestImg = extractImageUrl(c)
  const persisted = bestImg ? await persistThumb(adId, bestImg) : null
  return {
    record: {
      ad_id: adId,
      platform: 'meta',
      ad_name: json.name || null,
      status: json.status || null,
      effective_status: json.effective_status || null,
      creative_id: c?.id || json.creative_id || null,
      asset_type: detectAssetType(c),
      asset_url: persisted || bestImg || null,
      thumbnail_url: persisted || bestImg || c?.thumbnail_url || null,
      ...extractMeta(c),
      raw_payload: json,
      last_synced_at: new Date().toISOString(),
    },
    persisted: !!persisted,
  }
}

// ─── identify cohorts ────────────────────────────────────────────────────
console.log('\n=== COHORTS ===')

const { count: nullCount } = await supabase.from('ads')
  .select('*', { count: 'exact', head: true })
  .is('creative_id', null)
console.log(`Cohort A: ads with NULL creative_id  → ${nullCount}`)

const { count: staleCount } = await supabase.from('ads')
  .select('*', { count: 'exact', head: true })
  .not('asset_url', 'is', null)
  .not('asset_url', 'ilike', '%supabase.co%')
console.log(`Cohort B: ads with Meta CDN asset_url (will expire) → ${staleCount}`)

if (!RUN) {
  console.log('\nDry run. Pass --run to backfill.')
  process.exit(0)
}

// ─── do the work ─────────────────────────────────────────────────────────
async function processBatch(rows, label) {
  console.log(`\n=== ${label} — ${rows.length} ads ===`)
  let okThumb = 0, okMeta = 0, errs = 0
  const concurrency = 6
  for (let i = 0; i < rows.length; i += concurrency) {
    const slice = rows.slice(i, i + concurrency)
    const results = await Promise.all(slice.map(r => fetchOne(r.ad_id)))
    for (const r of results) {
      if (r.error) { errs++; continue }
      okMeta++
      if (r.persisted) okThumb++
      const { error } = await supabase.from('ads').upsert(r.record, { onConflict: 'ad_id' })
      if (error) { console.warn(`  upsert ${r.record.ad_id} failed: ${error.message}`); errs++ }
    }
    if ((i + slice.length) % 30 < concurrency || i + slice.length === rows.length) {
      console.log(`  progress: ${i + slice.length}/${rows.length}  meta=${okMeta}  thumb=${okThumb}  err=${errs}`)
    }
  }
  console.log(`Done ${label}: meta=${okMeta}/${rows.length}  thumb=${okThumb}  errors=${errs}`)
}

const cohortALimit = Math.min(nullCount || 0, LIMIT)
const { data: cohortA } = await supabase.from('ads')
  .select('ad_id').is('creative_id', null).limit(cohortALimit)
if (cohortA?.length) await processBatch(cohortA, `Cohort A (NULL creative_id)`)

const remaining = Math.max(0, LIMIT - (cohortA?.length || 0))
if (remaining > 0) {
  const cohortBLimit = Math.min(staleCount || 0, remaining)
  const { data: cohortB } = await supabase.from('ads')
    .select('ad_id').not('asset_url', 'is', null).not('asset_url', 'ilike', '%supabase.co%')
    .limit(cohortBLimit)
  if (cohortB?.length) await processBatch(cohortB, `Cohort B (stale Meta CDN URLs)`)
}

console.log('\n✓ backfill complete')
