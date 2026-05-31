#!/usr/bin/env node
/**
 * One-shot Meta ads sync, bypassing the browser.
 * Pulls 30 days of insights + creatives and writes to public.ads + public.ad_daily_stats.
 * Uses the same Vite env vars the browser uses (VITE_SUPABASE_*).
 *
 * Run: node scripts/sync-meta-ads-now.mjs
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

// Load .env manually so we don't depend on dotenv
const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const env = Object.fromEntries(
  envText.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')]
    })
)

const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_KEY = env.VITE_SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY
const ACCOUNT_ID   = env.VITE_META_ADS_ACCOUNT_ID
const META_TOKEN   = env.VITE_META_ADS_ACCESS_TOKEN
const KEY_KIND     = env.VITE_SUPABASE_SERVICE_ROLE_KEY ? 'service_role' : 'anon'

if (!SUPABASE_URL || !SUPABASE_KEY || !ACCOUNT_ID || !META_TOKEN) {
  console.error('Missing env. Need VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY + VITE_META_ADS_ACCOUNT_ID + VITE_META_ADS_ACCESS_TOKEN')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

console.log(`[sync] starting · key=${KEY_KIND} · account=${ACCOUNT_ID}`)

const BASE = 'https://graph.facebook.com/v21.0'
const DAYS = parseInt(process.argv[2] || '30')

const since = new Date()
since.setDate(since.getDate() - DAYS)
const sinceStr = since.toISOString().split('T')[0]
const untilStr = new Date().toISOString().split('T')[0]

const INSIGHT_FIELDS = [
  'ad_id','ad_name','campaign_id','campaign_name','adset_id','adset_name',
  'spend','impressions','reach','frequency','clicks','unique_clicks','ctr','cpc','cpm',
  'actions','cost_per_action_type','video_thruplay_watched_actions','video_avg_time_watched_actions',
].join(',')

const CREATIVE_FIELDS = [
  'name','status','effective_status',
  'creative{id,image_url,video_id,thumbnail_url,body,title,object_type,call_to_action_type,object_story_spec}',
].join(',')

const adIds = new Set()
// Campaign/adset metadata snapshot from the insights endpoint, keyed by
// ad_id. The /{ad_id} creative endpoint we hit next does NOT return
// campaign_id / campaign_name / adset_id / adset_name (Ben 2026-06-01:
// 222 ads landed in `ads` with NULL campaign_name because the sync only
// took those fields from creatives). Capture them here and merge into
// the ads upsert below.
const adMeta = {} // { ad_id: { campaign_id, campaign_name, adset_id, adset_name } }
let pageNum = 0
let totalRows = 0
let totalErrors = 0
const startedAt = Date.now()

console.log(`[sync] insights window: ${sinceStr} → ${untilStr}`)

let url = `${BASE}/act_${ACCOUNT_ID}/insights?` + new URLSearchParams({
  access_token: META_TOKEN,
  level: 'ad',
  fields: INSIGHT_FIELDS,
  time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
  time_increment: '1',
  limit: '500',
}).toString()

// Phase 1: collect insight rows in memory first (no upsert yet — FK requires
// ads to exist, so we have to write ads first).
const allInsightBatches = []
while (url) {
  pageNum++
  const t = Date.now()
  const res = await fetch(url)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error(`[sync] insights page ${pageNum} HTTP ${res.status}:`, err.error?.message || res.statusText)
    process.exit(2)
  }
  const json = await res.json()
  const rows = json.data || []

  const batch = []
  for (const row of rows) {
    if (!row.ad_id) continue
    adIds.add(row.ad_id)
    // Capture campaign/adset metadata the first time we see this ad.
    // Insights rows for the same ad-day all carry the same campaign info.
    if (!adMeta[row.ad_id]) {
      adMeta[row.ad_id] = {
        campaign_id:   row.campaign_id   || null,
        campaign_name: row.campaign_name || null,
        adset_id:      row.adset_id      || null,
        adset_name:    row.adset_name    || null,
      }
    }
    const v3sAction     = (row.actions || []).find(a => a.action_type === 'video_view')
    const thruAction    = (row.video_thruplay_watched_actions || []).find(a => a.action_type === 'video_view')
    const avgTimeAction = (row.video_avg_time_watched_actions || []).find(a => a.action_type === 'video_view')
    const resultAction  = (row.actions || []).find(a => ['lead','offsite_conversion.fb_pixel_lead','onsite_conversion.lead_grouped'].includes(a.action_type))
    const costPerResult = (row.cost_per_action_type || []).find(a => ['lead','offsite_conversion.fb_pixel_lead','onsite_conversion.lead_grouped'].includes(a.action_type))
    batch.push({
      ad_id: row.ad_id,
      date: row.date_start,
      spend: parseFloat(row.spend || 0),
      impressions: parseInt(row.impressions || 0),
      reach: parseInt(row.reach || 0),
      frequency: parseFloat(row.frequency || 0),
      clicks: parseInt(row.clicks || 0),
      unique_clicks: parseInt(row.unique_clicks || 0),
      ctr: row.ctr != null ? parseFloat(row.ctr) : null,
      cpc: row.cpc != null ? parseFloat(row.cpc) : null,
      cpm: row.cpm != null ? parseFloat(row.cpm) : null,
      video_3s_views: v3sAction ? parseInt(v3sAction.value) : 0,
      video_thruplays: thruAction ? parseInt(thruAction.value) : 0,
      video_avg_time_watched: avgTimeAction ? parseFloat(avgTimeAction.value) : null,
      results: resultAction ? parseInt(resultAction.value) : 0,
      cost_per_result: costPerResult ? parseFloat(costPerResult.value) : null,
      raw_payload: row,
      synced_at: new Date().toISOString(),
    })
  }
  allInsightBatches.push(batch)

  console.log(`[sync] insights p${pageNum}: collected ${batch.length} rows (total ads seen=${adIds.size}) ${((Date.now() - t) / 1000).toFixed(1)}s`)
  url = json.paging?.next || null
}

console.log(`[sync] insights collection done: ${pageNum} pages, ${adIds.size} ads, ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)

// ── Fetch creatives in parallel batches of 8
const ids = [...adIds]
console.log(`[sync] fetching ${ids.length} creatives ...`)
const records = []
let creativeErrors = 0
const concurrency = 8
for (let i = 0; i < ids.length; i += concurrency) {
  const slice = ids.slice(i, i + concurrency)
  const results = await Promise.all(slice.map(async (ad_id) => {
    try {
      const r = await fetch(`${BASE}/${ad_id}?access_token=${META_TOKEN}&fields=${CREATIVE_FIELDS}`)
      if (!r.ok) return null
      return await r.json()
    } catch (e) { return null }
  }))
  for (const json of results) {
    if (!json || !json.id) { creativeErrors++; continue }
    const c = json.creative || null
    const oss = c?.object_story_spec || {}
    const linkData = oss.link_data
    const videoData = oss.video_data
    const headline = c?.title || linkData?.name || videoData?.title || null
    const primary_text = c?.body || linkData?.message || videoData?.message || null
    const description = linkData?.description || null
    const cta_type = c?.call_to_action_type || linkData?.call_to_action?.type || videoData?.call_to_action?.type || null
    const destination_url = linkData?.link || videoData?.call_to_action?.value?.link || null
    const asset_type = c?.video_id || c?.object_type === 'VIDEO' ? 'video'
                     : c?.image_url ? 'image'
                     : c?.object_type === 'SHARE' && linkData?.child_attachments ? 'carousel'
                     : 'unknown'
    const thumbnail_url = c?.thumbnail_url || c?.image_url || null
    const archived = ['DELETED','ARCHIVED'].includes(json.effective_status || json.status)
    const meta = adMeta[json.id] || {}
    records.push({
      ad_id: json.id,
      platform: 'meta',
      ad_name: json.name || null,
      campaign_id: meta.campaign_id,
      campaign_name: meta.campaign_name,
      adset_id: meta.adset_id,
      adset_name: meta.adset_name,
      status: json.status || null,
      effective_status: json.effective_status || null,
      creative_id: c?.id || null,
      asset_type,
      asset_url: c?.image_url || null,
      thumbnail_url,
      headline, primary_text, description, cta_type, destination_url,
      raw_payload: json,
      last_synced_at: new Date().toISOString(),
      archived_at: archived ? new Date().toISOString() : null,
    })
  }
  if ((i + concurrency) % 80 === 0 || i + concurrency >= ids.length) {
    console.log(`[sync] creatives ${Math.min(i + concurrency, ids.length)}/${ids.length}`)
  }
}

if (records.length) {
  console.log(`[sync] upserting ${records.length} ads in one batch...`)
  const { error } = await supabase.from('ads').upsert(records, { onConflict: 'ad_id' })
  if (error) {
    console.error('[sync] ads upsert error:', error.message, '| code:', error.code, '| details:', error.details)
    console.error('[sync] aborting — daily stats need ads to exist for FK')
    process.exit(3)
  } else {
    console.log(`[sync] ads upsert OK`)
  }
}

// Phase 2: now that ads exist, write the insight batches.
console.log(`[sync] writing ${allInsightBatches.length} batches of insights ...`)
for (let i = 0; i < allInsightBatches.length; i++) {
  const batch = allInsightBatches[i]
  if (!batch.length) continue
  const { error } = await supabase.from('ad_daily_stats').upsert(batch, { onConflict: 'ad_id,date' })
  if (error) {
    console.error(`[sync] insights batch ${i + 1} error:`, error.message, '| code:', error.code)
    totalErrors += batch.length
  } else {
    totalRows += batch.length
  }
  console.log(`[sync] insights batch ${i + 1}/${allInsightBatches.length}: ${totalRows} total, ${totalErrors} errors`)
}

console.log(`[sync] DONE — ${totalRows} stat rows, ${records.length} ads, ${totalErrors + creativeErrors} errors, ${((Date.now() - startedAt) / 1000).toFixed(1)}s total`)
